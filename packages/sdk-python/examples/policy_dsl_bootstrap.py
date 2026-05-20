"""
Install a starter Policy DSL by pulling one of the gateway's
built-in examples and PUTting it into your tenant's config.

Useful as a one-shot bootstrap: pick "Block unsafe code generation"
or "Pause on alignment drift" the first time you set up AEGIS, then
edit it in the Cockpit's `/dsl` page from there.

Run:
    AEGIS_API_KEY=... python policy_dsl_bootstrap.py block-unsafe-code-gen
"""
from __future__ import annotations

import json
import os
import sys

import httpx

GATEWAY_URL = os.environ.get("AGENTGUARD_URL", "http://localhost:8080")
API_KEY = os.environ.get("AEGIS_API_KEY") or os.environ.get("AGENTGUARD_API_KEY")


def main() -> None:
    if not API_KEY:
        raise SystemExit(
            "Set AEGIS_API_KEY first. Get one with:\n"
            "  curl -s $AGENTGUARD_URL/api/v1/auth/key | jq -r .api_key"
        )

    headers = {"x-api-key": API_KEY}
    with httpx.Client(base_url=GATEWAY_URL, headers=headers, timeout=10) as c:
        # 1. Fetch the catalog.
        catalog = c.get("/api/v1/dsl/examples").json()
        examples = catalog["examples"]

        # 2. Pick by id from argv, else list and exit.
        target_id = sys.argv[1] if len(sys.argv) > 1 else None
        if not target_id:
            print("Available DSL examples:")
            for ex in examples:
                print(f"  {ex['id']:<32}  {ex['name']}")
            print()
            print("Re-run with the id of the one you want to install.")
            return

        match = next((e for e in examples if e["id"] == target_id), None)
        if not match:
            raise SystemExit(f"No example with id={target_id!r}")

        # 3. Install it. The PUT replaces any existing DSL atomically.
        put = c.put("/api/v1/dsl", json=match["dsl"])
        put.raise_for_status()
        print(f"✓ Installed DSL '{match['name']}' ({len(match['dsl']['rules'])} rule(s))")
        print()
        print("Current DSL:")
        print(json.dumps(put.json().get("dsl"), indent=2))


if __name__ == "__main__":
    main()
