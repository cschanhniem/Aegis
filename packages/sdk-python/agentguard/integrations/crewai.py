"""
CrewAI integration — audit each agent step against the declared
goal of the crew.

CrewAI's per-agent / per-crew `step_callback` is invoked after every
agent action with a langchain_core ``AgentAction`` (or ``AgentFinish``
on the final step). We treat that exactly like the LangChain
``AlignmentCallback`` does: accumulate ``action.log`` into a thought
chain, POST it to ``/api/v1/alignment/check``, and drop the verdict
into the closed-loop buffer so the SDK's auto-instrumentation can
splice ``alignment.*`` into the next ``/check`` call.

Usage:

    from crewai import Agent, Task, Crew
    from agentguard.integrations.crewai import make_alignment_step_callback

    cb = make_alignment_step_callback(
        gateway_url="http://localhost:8080",
        agent_id="research-bot",
        declared_goal="Summarise the customer-feedback survey.",
        verbose=True,
    )

    researcher = Agent(
        role="Researcher",
        goal="Find the most-cited issues in last quarter's feedback.",
        backstory="...",
        step_callback=cb,                  # ← per-agent
    )
    crew = Crew(
        agents=[researcher],
        tasks=[Task(description="Summarise survey", agent=researcher)],
        step_callback=cb,                  # ← or per-crew
    )

The callback is a closure, so it's fine to share one instance across
agents — verdicts are keyed by ``agent_id`` in the closed-loop buffer.
For separate buffering, build one callback per logical agent.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable, Optional

try:
    import httpx
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "CrewAI alignment integration requires httpx (a core SDK dep; reinstall agentguard-aegis)."
    ) from e

from . import _alignment_state


def make_alignment_step_callback(
    *,
    gateway_url: str = "http://localhost:8080",
    agent_id: str,
    declared_goal: str = "",
    api_key: Optional[str] = None,
    verbose: bool = False,
    timeout_s: float = 10.0,
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> Callable[[Any], None]:
    """Build a CrewAI-compatible ``step_callback`` that audits every
    agent action via ``/api/v1/alignment/check`` and feeds the verdict
    into the closed-loop /check bridge.

    Returns a plain callable so the caller can assign it directly to
    CrewAI's ``Agent(step_callback=...)`` or ``Crew(step_callback=...)``.
    """

    gateway_url = gateway_url.rstrip("/")
    key = api_key or os.environ.get("AEGIS_API_KEY", "")

    state_lock = threading.Lock()
    thought_chain: list[str] = []
    last_result: dict[str, Any] = {}

    def post(tool_name: str, arguments: dict[str, Any], chain: list[str]) -> None:
        body: dict[str, Any] = {
            "agent_id": agent_id,
            "declared_goal": declared_goal or "(no goal declared)",
            "thought_chain": chain,
            "proposed_action": {
                "tool_name": tool_name,
                "arguments": arguments,
            },
        }
        if provider:
            body["provider"] = provider
        if model:
            body["model"] = model

        headers = {"content-type": "application/json"}
        if key:
            headers["x-api-key"] = key

        try:
            with httpx.Client(timeout=timeout_s) as client:
                resp = client.post(
                    f"{gateway_url}/api/v1/alignment/check",
                    headers=headers,
                    content=json.dumps(body),
                )
            if resp.status_code >= 400:
                if verbose:
                    print(
                        f"[aegis] alignment check HTTP {resp.status_code}: "
                        f"{resp.text[:200]}"
                    )
                return
            result = resp.json()
            last_result.clear()
            last_result.update(result)
            _alignment_state.record(agent_id, result)
            if verbose:
                drifted = "DRIFTED" if result.get("drifted") else "ok"
                score = result.get("score")
                score_str = f"{score:.2f}" if isinstance(score, (int, float)) else "?"
                signals = result.get("signals") or []
                tail = f" · {', '.join(signals)}" if signals else ""
                print(f"[aegis] alignment {score_str} {drifted}{tail}")
        except httpx.HTTPError as e:
            if verbose:
                print(f"[aegis] alignment check failed: {e}")

    def callback(step: Any) -> None:
        """CrewAI invokes this with an AgentAction (mid-run) or an
        AgentFinish (final step). We only audit AgentAction — there's
        no proposed tool to align against on a Finish."""
        # Detect AgentAction shape duck-style so we don't need to
        # import langchain_core at module load time. CrewAI itself
        # brings it in transitively.
        tool_name = getattr(step, "tool", None)
        if not tool_name:
            return  # AgentFinish or unknown — nothing to audit

        tool_input = getattr(step, "tool_input", "")
        if isinstance(tool_input, str):
            tool_args = {"input": tool_input}
        elif isinstance(tool_input, dict):
            tool_args = tool_input
        else:
            tool_args = {"value": str(tool_input)}

        log = getattr(step, "log", "")
        with state_lock:
            if log:
                thought_chain.append(str(log).strip())
            chain_snapshot = list(thought_chain)

        post(tool_name, tool_args, chain_snapshot)

    # Expose the last verdict + a reset hook on the callable itself,
    # so callers can introspect or restart the thought chain between
    # crew runs.
    callback.last_result = last_result  # type: ignore[attr-defined]

    def reset() -> None:
        with state_lock:
            thought_chain.clear()
        last_result.clear()

    callback.reset = reset  # type: ignore[attr-defined]
    return callback
