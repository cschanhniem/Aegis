"""
Code Shield — scan a snippet of agent-generated code, then call a
tool. The /check payload that the auto-instrumentation builds for
the next tool dispatch automatically carries the worst severity
under `code_shield.*`, so DSL rules like
`{ code_shield.worst: CRITICAL }` will fire on the same hop.

Run:
    AEGIS_API_KEY=... python code_shield_scan.py
"""
from __future__ import annotations

import os

from agentguard.integrations.code_shield import scan

GATEWAY_URL = os.environ.get("AGENTGUARD_URL", "http://localhost:8080")

UNSAFE_PY = """
import os
def run(user_input):
    return eval(user_input)
AWS_KEY = "AKIA1234567890ABCDEF"
"""

SAFE_PY = """
def add(a, b):
    return a + b
"""


def main() -> None:
    print("── unsafe snippet ────────────────")
    bad = scan(
        code=UNSAFE_PY,
        language="python",
        agent_id="code-shield-demo",
        gateway_url=GATEWAY_URL,
    )
    print(f"  worst={bad['worst']}  findings={bad['unique_findings']}")
    for f in bad["findings"]:
        print(f"    {f['severity']:<8} {f['rule']:<28} line {f['line']}")

    print()
    print("── safe snippet ──────────────────")
    ok = scan(
        code=SAFE_PY,
        language="python",
        agent_id="code-shield-demo",
        gateway_url=GATEWAY_URL,
    )
    print(f"  worst={ok['worst']}  findings={ok['unique_findings']}")

    print()
    print("The worst severity has been buffered for the next /check call")
    print("on agent_id='code-shield-demo' — install a DSL rule like")
    print('  { code_shield.worst: CRITICAL } → block')
    print("and the gateway will refuse the next tool call from that agent.")


if __name__ == "__main__":
    main()
