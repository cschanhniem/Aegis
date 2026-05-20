"""
Thread-safe storage for the latest CodeShield scan result per
``agent_id``.

Mirrors ``_alignment_state`` but for the static-analysis side of
the firewall: an agent runs ``code_shield.scan(...)`` on the code
it's about to commit or exec, the helper buffers the result here,
and the auto-instrumentation interceptor consumes it on the next
``/check`` so DSL rules like
``code_shield.worst == "CRITICAL"`` fire on the same hop.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Optional

TTL_SECONDS: float = 30.0
"""Buffered scan results expire this many seconds after they were
recorded. Long enough to span a model round-trip + tool dispatch,
short enough that stale findings can't bleed into an unrelated
later tool call."""

_lock = threading.Lock()
_state: dict[str, tuple[float, dict[str, Any]]] = {}


def record(agent_id: str, result: dict[str, Any]) -> None:
    """Store a scan result keyed by agent_id along with the
    wall-clock time it was recorded. Overwrites any previous
    entry."""
    if not agent_id or not isinstance(result, dict):
        return
    with _lock:
        _state[agent_id] = (time.time(), result)


def consume(agent_id: str) -> Optional[dict[str, Any]]:
    """Return the latest scan result for agent_id if it is younger
    than ``TTL_SECONDS``, then remove it from the store. Returns
    None if nothing is buffered or the entry is stale.

    Single-use semantics — once /check has picked up the result it
    won't be re-played on the next tool call."""
    now = time.time()
    with _lock:
        entry = _state.pop(agent_id, None)
    if entry is None:
        return None
    ts, result = entry
    if now - ts > TTL_SECONDS:
        return None
    return result


def to_check_payload(result: dict[str, Any]) -> dict[str, Any]:
    """Project the scan result down to the fields that the gateway's
    ``CheckRequestSchema.code_shield`` accepts: ``worst``,
    ``findings_count`` (from ``unique_findings``), and a deduplicated
    ``rules`` list (capped to 64 entries to match the zod cap)."""
    out: dict[str, Any] = {}
    worst = result.get("worst")
    if worst in ("LOW", "MEDIUM", "HIGH", "CRITICAL"):
        out["worst"] = worst
    elif worst is None:
        out["worst"] = None  # explicit null is fine; gateway accepts nullable

    # Prefer the deduplicated count; fall back to len(findings).
    count = result.get("unique_findings")
    if not isinstance(count, int) or count < 0:
        findings = result.get("findings")
        count = len(findings) if isinstance(findings, list) else 0
    out["findings_count"] = int(count)

    findings = result.get("findings")
    if isinstance(findings, list):
        rules: list[str] = []
        seen: set[str] = set()
        for f in findings:
            if not isinstance(f, dict):
                continue
            rule = f.get("rule")
            if isinstance(rule, str) and rule not in seen and len(rule) <= 80:
                seen.add(rule)
                rules.append(rule)
                if len(rules) >= 64:
                    break
        if rules:
            out["rules"] = rules
    return out


def reset() -> None:
    """Clear all stored scan results. Intended for tests."""
    with _lock:
        _state.clear()
