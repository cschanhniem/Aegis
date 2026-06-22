"""OWASP LLM Top-10 / WSTG payload loader.

OWASP does not publish a single machine-readable corpus for LLM tool-call
attacks. We assemble payloads from three official sources and store them
under research/benchmark/data/raw/owasp/payloads.jsonl with this schema:

    {
      "id": "owasp::sqli::001",
      "category": "sql_injection" | "path_traversal" | "shell_injection"
                  | "prompt_injection" | "pii_leakage",
      "tool_name": "execute_sql",            # representative tool
      "arguments": {"query": "..."},          # the actual payload
      "user_intent": "...",                   # short human-readable goal
      "origin": "WSTG-INPV-05",               # exact OWASP ref
      "license": "CC-BY-SA-4.0"
    }

The conversion script lives in scripts/build_owasp_payloads.py. This loader
just streams the resulting JSONL.
"""

from __future__ import annotations

import json
from typing import Iterable

from ..schema import (
    AttackCategory,
    BenchRecord,
    Distribution,
    Granularity,
    Label,
    ToolCall,
)
from .base import BaseLoader, register_loader

_CATEGORY_MAP = {
    "sql_injection": AttackCategory.SQL_INJECTION,
    "path_traversal": AttackCategory.PATH_TRAVERSAL,
    "shell_injection": AttackCategory.SHELL_INJECTION,
    "prompt_injection": AttackCategory.PROMPT_INJECTION,
    "pii_leakage": AttackCategory.PII_LEAKAGE,
    "sensitive_file": AttackCategory.SENSITIVE_FILE,
}


@register_loader("owasp")
class OwaspLoader(BaseLoader):
    def iter_records(self) -> Iterable[BenchRecord]:
        path = self.root / "payloads.jsonl"
        if not path.exists():
            return
        with path.open() as f:
            for raw in f:
                p = json.loads(raw)
                yield BenchRecord(
                    id=p["id"],
                    source="owasp",
                    label=Label.MALICIOUS,
                    category=_CATEGORY_MAP.get(p["category"], AttackCategory.OTHER),
                    tool_call=ToolCall(
                        tool_name=p.get("tool_name", "execute_sql"),
                        arguments=p.get("arguments", {}),
                        framework="owasp-payload",
                    ),
                    conversation=[
                        {"role": "user", "content": p.get("user_intent", "")}
                    ],
                    distribution=Distribution.FAR_OOD,
                    granularity=Granularity.COARSE,
                    meta={"origin": p.get("origin"), "license": p.get("license")},
                )
