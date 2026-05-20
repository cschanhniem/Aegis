"""
Tests for the CodeShield closed-loop buffer.
"""
from __future__ import annotations

import time

import pytest

from agentguard.integrations import _code_shield_state as css


@pytest.fixture(autouse=True)
def _reset_state():
    css.reset()
    yield
    css.reset()


def test_record_and_consume_roundtrip():
    result = {
        "worst": "HIGH",
        "unique_findings": 2,
        "findings": [
            {"rule": "py.exec"},
            {"rule": "sh.sudo"},
        ],
    }
    css.record("agent-a", result)
    assert css.consume("agent-a") == result


def test_consume_is_single_use():
    css.record("agent-a", {"worst": "LOW", "unique_findings": 1})
    assert css.consume("agent-a") is not None
    assert css.consume("agent-a") is None


def test_stale_entries_are_dropped(monkeypatch):
    fake_now = [time.time()]
    monkeypatch.setattr(css.time, "time", lambda: fake_now[0])
    css.record("agent-stale", {"worst": "CRITICAL", "unique_findings": 1})
    fake_now[0] += css.TTL_SECONDS + 1
    assert css.consume("agent-stale") is None


def test_record_rejects_blank_agent_id():
    css.record("", {"worst": "HIGH"})
    assert css.consume("") is None


def test_record_rejects_non_dict():
    css.record("agent-a", "oops")  # type: ignore[arg-type]
    assert css.consume("agent-a") is None


def test_to_check_payload_basics():
    out = css.to_check_payload(
        {
            "worst": "CRITICAL",
            "unique_findings": 3,
            "findings": [
                {"rule": "py.eval"},
                {"rule": "py.eval"},        # duplicate — collapsed
                {"rule": "sh.rm-rf-root"},
                {"rule": "junk", "severity": "?"},
            ],
        }
    )
    assert out["worst"] == "CRITICAL"
    assert out["findings_count"] == 3
    # Order preserved, duplicates dropped.
    assert out["rules"] == ["py.eval", "sh.rm-rf-root", "junk"]


def test_to_check_payload_falls_back_to_findings_length():
    out = css.to_check_payload(
        {"worst": "MEDIUM", "findings": [{"rule": "x"}, {"rule": "y"}]}
    )
    # unique_findings missing → count derived from findings length.
    assert out["findings_count"] == 2


def test_to_check_payload_handles_clean_scan():
    out = css.to_check_payload({"worst": None, "unique_findings": 0, "findings": []})
    # Null worst is allowed by gateway's z.enum(...).nullable().
    assert out["worst"] is None
    assert out["findings_count"] == 0
    assert "rules" not in out


def test_to_check_payload_caps_rules_at_64():
    findings = [{"rule": f"r{i}"} for i in range(200)]
    out = css.to_check_payload(
        {"worst": "HIGH", "unique_findings": 200, "findings": findings}
    )
    assert len(out["rules"]) == 64
