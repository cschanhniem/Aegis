"""
Tests for the alignment-state buffer that bridges LangChain's sync
callback to the auto-instrumentation /check payload.
"""
from __future__ import annotations

import time

import pytest

from agentguard.integrations import _alignment_state as als


@pytest.fixture(autouse=True)
def _reset_state():
    als.reset()
    yield
    als.reset()


def test_record_and_consume_roundtrip():
    verdict = {"score": 0.42, "drifted": True, "signals": ["scope-expansion"]}
    als.record("agent-a", verdict)
    out = als.consume("agent-a")
    assert out == verdict


def test_consume_is_single_use():
    als.record("agent-a", {"score": 0.9, "drifted": False})
    assert als.consume("agent-a") is not None
    # Second consume returns nothing — keeps /check payloads tied to
    # one agent step instead of replaying stale verdicts forever.
    assert als.consume("agent-a") is None


def test_consume_returns_none_for_unknown_agent():
    assert als.consume("never-seen") is None


def test_stale_entries_are_dropped(monkeypatch):
    real_time = time.time
    # Freeze "now" before recording so we control the elapsed delta.
    fake_now = [real_time()]
    monkeypatch.setattr(als.time, "time", lambda: fake_now[0])
    als.record("agent-stale", {"score": 0.1})
    # Advance past the TTL.
    fake_now[0] += als.TTL_SECONDS + 1.0
    assert als.consume("agent-stale") is None


def test_record_rejects_blank_agent_id_and_non_dict():
    als.record("", {"score": 0.5})
    assert als.consume("") is None

    # Non-dict input silently dropped — defensive guard for callers
    # that mis-handle a non-JSON response.
    als.record("agent-x", "not a dict")  # type: ignore[arg-type]
    assert als.consume("agent-x") is None


def test_to_check_payload_clamps_score_and_truncates_signals():
    verdict = {
        "score": 1.7,                          # > 1 → clamp to 1.0
        "drifted": True,
        "signals": ["s" * 100, "ok"] + [f"x{i}" for i in range(10)],
        "reason": "r" * 1000,
        "junk": "ignored",
    }
    out = als.to_check_payload(verdict)
    assert out["score"] == 1.0
    assert out["drifted"] is True
    # First signal truncated to 40 chars, list capped to 5.
    assert len(out["signals"]) == 5
    assert len(out["signals"][0]) == 40
    assert len(out["reason"]) == 500
    assert "junk" not in out


def test_to_check_payload_handles_negative_score():
    out = als.to_check_payload({"score": -0.3})
    assert out["score"] == 0.0


def test_to_check_payload_returns_empty_when_no_relevant_fields():
    out = als.to_check_payload({"unrelated": 1})
    assert out == {}
