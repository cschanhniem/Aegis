"""
Quickstart — auto-instrument the Anthropic SDK with one call.

Before: a normal Anthropic + tool-use script runs as written.
After:  every tool_use block emitted by the model is policy-checked
        by the AEGIS gateway before your dispatcher ever sees it.

Run:
    AEGIS_API_KEY=... ANTHROPIC_API_KEY=... python quickstart_anthropic.py
"""
from __future__ import annotations

import os

import agentguard

GATEWAY_URL = os.environ.get("AGENTGUARD_URL", "http://localhost:8080")

# One line — patches both sync + async Anthropic Messages.create at
# import time. Every subsequent tool_use is sent to /api/v1/check
# (blocking mode) before the trace lands in /traces.
agentguard.auto(
    GATEWAY_URL,
    agent_id="quickstart-anthropic",
    blocking_mode=True,
)


def main() -> None:
    try:
        from anthropic import Anthropic
    except ImportError:
        raise SystemExit("pip install anthropic to run this example")

    client = Anthropic()
    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=512,
        tools=[
            {
                "name": "get_weather",
                "description": "Returns the current weather in a city.",
                "input_schema": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            }
        ],
        messages=[
            {"role": "user", "content": "What's the weather in San Francisco today?"}
        ],
    )

    print(f"stop_reason = {response.stop_reason}")
    for block in response.content:
        if getattr(block, "type", None) == "tool_use":
            print(f"  tool_use → {block.name}({dict(block.input)})")
            # The /check call already happened inside agentguard's interceptor
            # before this loop runs; if AEGIS had decided to block, the SDK
            # would have raised AgentGuardBlockedError above.


if __name__ == "__main__":
    main()
