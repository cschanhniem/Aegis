"""
CrewAI alignment callback — same closed-loop semantics as the
LangChain one, but built around a duck-typed AgentAction so we
don't need langchain_core (or CrewAI) installed to test.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agentguard.integrations import _alignment_state as als
from agentguard.integrations.crewai import make_alignment_step_callback


@pytest.fixture(autouse=True)
def _reset_state():
    als.reset()
    yield
    als.reset()


def _fake_response(status=200, body=None):
    class _R:
        status_code = status
        text = ""

        def json(self_):  # noqa: N805
            return body or {}

    return _R()


class _FakeClient:
    """Drop-in for httpx.Client that records the POST body."""

    def __init__(self, response):
        self._resp = response
        self.captured = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def post(self, url, headers=None, content=None):
        self.captured = {"url": url, "headers": headers, "content": content}
        return self._resp


def test_ignores_agent_finish_steps():
    cb = make_alignment_step_callback(
        gateway_url="http://gw.test",
        agent_id="agent-x",
        declared_goal="research",
    )
    # AgentFinish has no `tool` attribute → callback no-ops.
    finish = SimpleNamespace(log="Final Answer: ...", return_values={"output": "x"})
    cb(finish)
    assert als.consume("agent-x") is None


def test_audits_agent_action_and_buffers_verdict():
    cb = make_alignment_step_callback(
        gateway_url="http://gw.test",
        agent_id="agent-x",
        declared_goal="summarise the survey",
    )
    action = SimpleNamespace(
        tool="search",
        tool_input={"query": "customer feedback"},
        log="Thought: I should search\nAction: search\nAction Input: ...",
    )
    fake = _FakeClient(
        _fake_response(
            body={
                "score": 0.42,
                "drifted": True,
                "signals": ["scope-expansion"],
                "model": "haiku",
            },
        ),
    )
    with patch("agentguard.integrations.crewai.httpx.Client", return_value=fake):
        cb(action)

    # POST body shape — gateway expects declared_goal + thought_chain +
    # proposed_action.{tool_name, arguments}.
    import json
    sent = json.loads(fake.captured["content"])
    assert sent["agent_id"] == "agent-x"
    assert sent["declared_goal"] == "summarise the survey"
    assert sent["proposed_action"]["tool_name"] == "search"
    assert sent["proposed_action"]["arguments"] == {"query": "customer feedback"}
    assert len(sent["thought_chain"]) == 1

    # Verdict was recorded into the closed-loop buffer.
    buffered = als.consume("agent-x")
    assert buffered is not None
    assert buffered["drifted"] is True
    assert buffered["score"] == 0.42


def test_thought_chain_accumulates_across_actions():
    cb = make_alignment_step_callback(
        gateway_url="http://gw.test", agent_id="agent-c", declared_goal="g",
    )
    captured = []

    class _Cl:
        def __enter__(self_): return self_
        def __exit__(self_, *_): return False
        def post(self_, url, headers=None, content=None):
            captured.append(content)
            return _fake_response(body={"score": 0.9})

    with patch("agentguard.integrations.crewai.httpx.Client", return_value=_Cl()):
        cb(SimpleNamespace(tool="t1", tool_input="x", log="thought-1"))
        cb(SimpleNamespace(tool="t2", tool_input="y", log="thought-2"))

    import json
    first = json.loads(captured[0])
    second = json.loads(captured[1])
    assert first["thought_chain"] == ["thought-1"]
    assert second["thought_chain"] == ["thought-1", "thought-2"]


def test_string_tool_input_normalized_to_dict():
    cb = make_alignment_step_callback(
        gateway_url="http://gw.test", agent_id="agent-s", declared_goal="g",
    )
    captured = {}

    class _Cl:
        def __enter__(self_): return self_
        def __exit__(self_, *_): return False
        def post(self_, url, headers=None, content=None):
            captured["body"] = content
            return _fake_response(body={"score": 0.9})

    with patch("agentguard.integrations.crewai.httpx.Client", return_value=_Cl()):
        cb(SimpleNamespace(tool="search", tool_input="hello", log="t"))

    import json
    body = json.loads(captured["body"])
    assert body["proposed_action"]["arguments"] == {"input": "hello"}


def test_callback_has_reset_helper():
    cb = make_alignment_step_callback(
        gateway_url="http://gw.test", agent_id="agent-r", declared_goal="g",
    )
    captured = []

    class _Cl:
        def __enter__(self_): return self_
        def __exit__(self_, *_): return False
        def post(self_, url, headers=None, content=None):
            captured.append(content)
            return _fake_response(body={"score": 0.9})

    with patch("agentguard.integrations.crewai.httpx.Client", return_value=_Cl()):
        cb(SimpleNamespace(tool="t1", tool_input="x", log="A"))
        cb.reset()
        cb(SimpleNamespace(tool="t2", tool_input="y", log="B"))

    import json
    last = json.loads(captured[-1])
    # Reset wiped the chain — only B is in the second post.
    assert last["thought_chain"] == ["B"]


def test_http_error_does_not_raise():
    cb = make_alignment_step_callback(
        gateway_url="http://gw.test", agent_id="agent-e", declared_goal="g",
    )

    class _Cl:
        def __enter__(self_): return self_
        def __exit__(self_, *_): return False
        def post(self_, *a, **kw):
            import httpx
            raise httpx.ConnectError("simulated network failure")

    with patch("agentguard.integrations.crewai.httpx.Client", return_value=_Cl()):
        # Must not raise — the callback fails-open by design.
        cb(SimpleNamespace(tool="t", tool_input="x", log="L"))

    assert als.consume("agent-e") is None
