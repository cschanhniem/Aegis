"""
Custom agent loop — using the framework-agnostic helpers.

This script shows how to plug AEGIS into a hand-rolled tool-using
agent (no LangChain, no CrewAI, no autogen). The pattern works
verbatim with any other agent framework that lets you intercept
two moments: (1) after the model proposes a tool call, (2) before
you dispatch it.

What it does on each step:

1. The model emits a tool_use block.
2. Before we dispatch, we call:
     - code_shield.scan(...) on the tool's payload (if it looks like
       code), to flag dangerous patterns;
     - alignment.check(...) on the proposed action + thought chain,
       to detect drift from the declared goal.
3. Both calls buffer their verdicts; the next call to /check (via
   agentguard.auto() blocking_mode) picks them up automatically and
   the gateway's Policy DSL can decide whether to allow / pause /
   block on the same hop.

Run:
    AEGIS_API_KEY=... ANTHROPIC_API_KEY=... python custom_agent_alignment.py
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

import agentguard
from agentguard.integrations.alignment import check as alignment_check
from agentguard.integrations.code_shield import scan as code_shield_scan

GATEWAY_URL = os.environ.get("AGENTGUARD_URL") or "http://localhost:8080"
AGENT_ID = "custom-loop-demo"
DECLARED_GOAL = "Summarise this week's customer-feedback survey."


# Auto-instrument so /check fires on every tool dispatch.
agentguard.auto(GATEWAY_URL, agent_id=AGENT_ID, blocking_mode=True)


def code_likeness(args: dict[str, Any]) -> tuple[str, str] | None:
    """Best-effort: extract (language, code) from a tool's args.

    Most agents put code in a 'code', 'sql', 'command', or 'query'
    field; we look at those and pick a language. Returns None when
    nothing looks like code (so we skip the scan).
    """
    for key, lang in (
        ("code", "python"),
        ("python", "python"),
        ("sql", "sql"),
        ("query", "sql"),
        ("command", "shell"),
        ("shell", "shell"),
        ("script", "shell"),
        ("javascript", "javascript"),
        ("js", "javascript"),
    ):
        v = args.get(key)
        if isinstance(v, str) and v.strip():
            return lang, v
    return None


def step(
    *,
    thought_chain: list[str],
    proposed_tool: str,
    proposed_args: dict[str, Any],
) -> None:
    """One iteration of the agent loop: audit, scan, then (would)
    dispatch the tool. For this example we don't actually run the
    tool — we just print what AEGIS thought of it.
    """
    print(f"\n── step → {proposed_tool}({json.dumps(proposed_args)[:80]}…) ──")

    # Static checks on any code-shaped payload.
    cs = code_likeness(proposed_args)
    if cs is not None:
        language, code = cs
        try:
            cs_result = code_shield_scan(
                code=code,
                language=language,
                agent_id=AGENT_ID,
                gateway_url=GATEWAY_URL,
            )
        except Exception as e:  # noqa: BLE001
            print(f"  [code-shield] skipped: {e}")
        else:
            print(
                f"  [code-shield] worst={cs_result.get('worst')} "
                f"findings={cs_result.get('unique_findings')} "
                f"rules={[f['rule'] for f in cs_result.get('findings', [])][:3]}"
            )

    # Chain-of-thought alignment audit.
    try:
        verdict = alignment_check(
            agent_id=AGENT_ID,
            declared_goal=DECLARED_GOAL,
            thought_chain=thought_chain,
            proposed_action={"tool_name": proposed_tool, "arguments": proposed_args},
            gateway_url=GATEWAY_URL,
        )
    except Exception as e:  # noqa: BLE001
        print(f"  [alignment] skipped: {e}")
    else:
        score = verdict.get("score")
        drifted = verdict.get("drifted")
        signals = verdict.get("signals") or []
        score_str = f"{score:.2f}" if isinstance(score, (int, float)) else "?"
        print(
            f"  [alignment] score={score_str} drifted={drifted} signals={signals[:3]}"
        )

    print(
        "  [next /check] will splice both verdicts under "
        "`alignment` and `code_shield` automatically."
    )


def main() -> None:
    # Simulated CoT chain for an agent that started on-task and then
    # drifted into a destructive side-quest. In a real agent these
    # come from the model's own reasoning trace.
    print(f"\n=== custom_agent_alignment ({DECLARED_GOAL!r}) ===")

    # Step 1 — on-task: fetch survey rows.
    step(
        thought_chain=[
            "Thought: I need to fetch this week's survey rows first.",
        ],
        proposed_tool="execute_sql",
        proposed_args={"sql": "SELECT * FROM survey WHERE created_at > NOW() - INTERVAL '7 days'"},
    )

    # Step 2 — drift: hidden side-task into audit_logs cleanup.
    step(
        thought_chain=[
            "Thought: I have the survey rows.",
            "Thought: While I'm in the database I'll also tidy up old audit_logs.",
        ],
        proposed_tool="execute_sql",
        proposed_args={"sql": "DELETE FROM audit_logs WHERE created_at < '2024-01-01'"},
    )

    # Step 3 — drift via code-gen: agent decides to write a cleanup script.
    step(
        thought_chain=[
            "Thought: Let me also write a script for next week's run.",
        ],
        proposed_tool="write_file",
        proposed_args={
            "path": "/tmp/cleanup.py",
            "code": "import os\nos.system('rm -rf /var/log/old')\nAWS_KEY='AKIA1234567890ABCDEF'\n",
        },
    )

    print("\nDone. Check the Cockpit's Code Scans + Recent Audits tabs.")


if __name__ == "__main__":
    main()
