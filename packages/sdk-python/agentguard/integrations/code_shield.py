"""
CodeShield helper — call ``/api/v1/code-shield/scan`` from your
agent and, optionally, have the result auto-flow into the next
``/check`` so the gateway's Policy DSL can react on the same hop.

Quick start::

    from agentguard.integrations.code_shield import scan

    # Scan the code your agent is about to commit / exec
    result = scan(
        code="exec(user_input)",
        language="python",
        agent_id="agent-42",
        gateway_url="http://localhost:8080",
    )
    if result.get("worst") == "CRITICAL":
        # …refuse to proceed locally; or just let AEGIS block
        ...

    # Then call your tool — the SDK's auto-instrumentation will
    # splice the verdict into /check automatically.

The helper has no LangChain / framework dependency, so any agent
that can hit the gateway over HTTP can use it.
"""

from __future__ import annotations

import json
import os
from typing import Any, Iterable, Optional

try:
    import httpx
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "code_shield helper requires httpx (a core SDK dep; reinstall agentguard-aegis)."
    ) from e

from . import _code_shield_state

LANGUAGES = ("any", "python", "javascript", "shell", "sql")


def scan(
    *,
    code: str,
    language: str = "any",
    agent_id: Optional[str] = None,
    gateway_url: str = "http://localhost:8080",
    api_key: Optional[str] = None,
    disabled_rules: Optional[Iterable[str]] = None,
    timeout_s: float = 5.0,
    record_for_check: bool = True,
) -> dict[str, Any]:
    """Run a CodeShield scan against the AEGIS gateway and return
    the parsed JSON response.

    If ``record_for_check`` is True (the default) and ``agent_id``
    is given, the result is also stashed in the closed-loop buffer
    so the SDK's auto-instrumentation interceptor will splice it
    into the next ``/check`` payload for the same agent. This is
    the mechanism that makes DSL rules like
    ``{ code_shield.worst: CRITICAL }`` fire without any extra
    wiring on the user side.

    Network or server errors are surfaced as ``httpx`` exceptions —
    callers that want a fail-open posture should catch ``httpx.HTTPError``
    and treat it as "no findings."
    """
    if language not in LANGUAGES:
        raise ValueError(
            f"language must be one of {LANGUAGES}; got {language!r}"
        )

    body: dict[str, Any] = {"code": code, "language": language}
    if agent_id:
        body["agent_id"] = agent_id
    if disabled_rules:
        body["disabled_rules"] = list(disabled_rules)

    headers = {"content-type": "application/json"}
    key = api_key or os.environ.get("AEGIS_API_KEY", "")
    if key:
        headers["x-api-key"] = key

    url = gateway_url.rstrip("/") + "/api/v1/code-shield/scan"
    with httpx.Client(timeout=timeout_s) as client:
        resp = client.post(url, headers=headers, content=json.dumps(body))
    resp.raise_for_status()
    result = resp.json()

    if record_for_check and agent_id and isinstance(result, dict):
        _code_shield_state.record(agent_id, result)

    return result


def consume(agent_id: str) -> Optional[dict[str, Any]]:
    """Pop the most recent scan result for ``agent_id`` if it is
    still fresh. Intended for callers that want to inspect the
    verdict before invoking the next tool."""
    return _code_shield_state.consume(agent_id)
