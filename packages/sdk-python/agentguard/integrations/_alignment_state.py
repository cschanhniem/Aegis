"""
Thread-safe storage for the latest alignment verdict per agent_id.

Why this exists: the LangChain `AlignmentCallback` runs on the
synchronous callback thread when a ReAct agent emits an action. The
SDK's auto-instrumentation interceptors (`auto.py`) run on whichever
thread or asyncio loop the user's Anthropic / OpenAI client lives on.
Those two paths may not share a Python execution context, so a plain
``ContextVar`` won't propagate.

Instead we keep a small module-level dict, keyed by ``agent_id``,
holding the most recent verdict and the time it was observed. The
auto-interceptor reads this when building the ``/check`` payload and
attaches the verdict if it's fresh (within ``TTL_SECONDS``). A stale
verdict from an earlier run is silently dropped.

Concurrency: the dict is guarded by a single ``threading.Lock``. All
operations are O(1) and the lock window is microseconds.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Optional

TTL_SECONDS: float = 30.0
"""Maximum age (in seconds) for a verdict to still be considered
fresh. Past this, the auto-interceptor will treat it as missing and
fall back to running /check without an alignment signal."""

_lock = threading.Lock()
_state: dict[str, tuple[float, dict[str, Any]]] = {}


def record(agent_id: str, verdict: dict[str, Any]) -> None:
    """Store a verdict keyed by agent_id along with the wall-clock
    time it was recorded. Overwrites any previous entry."""
    if not agent_id or not isinstance(verdict, dict):
        return
    with _lock:
        _state[agent_id] = (time.time(), verdict)


def consume(agent_id: str) -> Optional[dict[str, Any]]:
    """Return the latest verdict for agent_id if it is younger than
    ``TTL_SECONDS``, then remove it from the store. Returns None if
    nothing is buffered or the entry is stale.

    "Consume once" semantics keep the /check payload tied to a single
    agent step — the next tool call gets a fresh alignment check, not
    a re-played stale verdict."""
    now = time.time()
    with _lock:
        entry = _state.pop(agent_id, None)
    if entry is None:
        return None
    ts, verdict = entry
    if now - ts > TTL_SECONDS:
        return None
    return verdict


def to_check_payload(verdict: dict[str, Any]) -> dict[str, Any]:
    """Pick the fields that the gateway's ``CheckRequestSchema``
    accepts under ``alignment``, dropping anything unexpected.

    The gateway zod schema (see check.ts) currently allows: score,
    drifted, signals (≤5, ≤40 chars each), reason (≤500 chars).
    """
    out: dict[str, Any] = {}
    score = verdict.get("score")
    if isinstance(score, (int, float)):
        # Clamp to [0,1] — the gateway will validate the range anyway.
        out["score"] = max(0.0, min(1.0, float(score)))
    drifted = verdict.get("drifted")
    if isinstance(drifted, bool):
        out["drifted"] = drifted
    signals = verdict.get("signals")
    if isinstance(signals, list):
        # Truncate each signal and cap list length to match gateway
        # validation. Keeps the SDK robust to model regressions.
        out["signals"] = [
            str(s)[:40] for s in signals if isinstance(s, (str, int, float))
        ][:5]
    reason = verdict.get("reason")
    if isinstance(reason, str):
        out["reason"] = reason[:500]
    return out


def reset() -> None:
    """Clear all stored verdicts. Intended for tests."""
    with _lock:
        _state.clear()
