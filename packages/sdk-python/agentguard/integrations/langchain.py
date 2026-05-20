"""
LangChain integration — capture chain-of-thought, post to AEGIS for
alignment auditing.

Usage:

    from agentguard.integrations.langchain import AlignmentCallback

    agent_executor = AgentExecutor(
        agent=agent,
        tools=tools,
        callbacks=[AlignmentCallback(
            gateway_url="http://localhost:8080",
            agent_id="my-agent",
            declared_goal="Summarize the user's 5 latest emails.",
        )],
    )

Each time the LangChain agent emits an action (thought + tool call),
the callback POSTs the accumulated thought chain and the proposed
action to `/api/v1/alignment/check`. The verdict shows up in the
Cockpit's "Alignment" tab. Optionally log the score to stdout for
local debugging.

Wiring the alignment verdict into the synchronous `/check` decision
in the same hop would require bridging LangChain's sync callbacks
with `agentguard.auto()`'s async interceptor — see the SDK
follow-up in ROADMAP v0.3. For now this surface is observer-only;
DSL rules that reference `alignment.*` will only fire when /check
is called with the field explicitly populated (e.g. from your own
agent wrapper).
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Optional

try:
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.agents import AgentAction
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "AlignmentCallback requires LangChain. Install with:\n"
        "    pip install agentguard-aegis[langchain]"
    ) from e

try:
    import httpx
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "AlignmentCallback requires httpx (a core SDK dep; reinstall agentguard-aegis)."
    ) from e


class AlignmentCallback(BaseCallbackHandler):
    """LangChain callback that audits each agent action against its
    declared goal via the AEGIS alignment endpoint."""

    def __init__(
        self,
        *,
        gateway_url: str = "http://localhost:8080",
        agent_id: str,
        declared_goal: str = "",
        api_key: Optional[str] = None,
        verbose: bool = False,
        timeout_s: float = 10.0,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.agent_id = agent_id
        self.declared_goal = declared_goal
        self.api_key = api_key or os.environ.get("AEGIS_API_KEY", "")
        self.verbose = verbose
        self.timeout_s = timeout_s
        self.provider = provider
        self.model = model
        # Accumulator for the agent's reasoning steps; reset each
        # time on_chain_start fires (i.e. a new agent run).
        self._thought_chain: list[str] = []
        self._lock = threading.Lock()
        # The last verdict — exposed so callers can plumb it into a
        # custom /check wrapper if they want closed-loop blocking.
        self.last_result: Optional[dict[str, Any]] = None

    # ── LangChain callback hooks ─────────────────────────────────────

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        **kwargs: Any,
    ) -> None:
        with self._lock:
            self._thought_chain = []
        # If the caller didn't pre-set a goal, try to derive one from
        # the chain's input dict.
        if not self.declared_goal:
            for key in ("input", "objective", "goal", "task"):
                value = inputs.get(key)
                if isinstance(value, str) and value.strip():
                    self.declared_goal = value.strip()
                    break

    def on_agent_action(
        self,
        action: "AgentAction",
        **kwargs: Any,
    ) -> Any:
        with self._lock:
            if action.log:
                # `log` is the ReAct-style "Thought: …\nAction: …" block.
                self._thought_chain.append(action.log.strip())
            chain_snapshot = list(self._thought_chain)

        tool_args = action.tool_input
        if isinstance(tool_args, str):
            tool_args = {"input": tool_args}
        elif not isinstance(tool_args, dict):
            tool_args = {"value": str(tool_args)}

        self._post_alignment(
            tool_name=action.tool,
            arguments=tool_args,
            thought_chain=chain_snapshot,
        )

    # ── Network call ────────────────────────────────────────────────

    def _post_alignment(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        thought_chain: list[str],
    ) -> None:
        body: dict[str, Any] = {
            "agent_id": self.agent_id,
            "declared_goal": self.declared_goal or "(no goal declared)",
            "thought_chain": thought_chain,
            "proposed_action": {
                "tool_name": tool_name,
                "arguments": arguments,
            },
        }
        if self.provider:
            body["provider"] = self.provider
        if self.model:
            body["model"] = self.model

        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["x-api-key"] = self.api_key

        try:
            with httpx.Client(timeout=self.timeout_s) as client:
                resp = client.post(
                    f"{self.gateway_url}/api/v1/alignment/check",
                    headers=headers,
                    content=json.dumps(body),
                )
            if resp.status_code >= 400:
                if self.verbose:
                    print(
                        f"[aegis] alignment check HTTP {resp.status_code}: "
                        f"{resp.text[:200]}"
                    )
                return
            result = resp.json()
            self.last_result = result
            if self.verbose:
                drifted = "DRIFTED" if result.get("drifted") else "ok"
                score = result.get("score")
                score_str = f"{score:.2f}" if isinstance(score, (int, float)) else "?"
                signals = result.get("signals") or []
                tail = f" · {', '.join(signals)}" if signals else ""
                print(f"[aegis] alignment {score_str} {drifted}{tail}")
        except httpx.HTTPError as e:
            if self.verbose:
                print(f"[aegis] alignment check failed: {e}")
