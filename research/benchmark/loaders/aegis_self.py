"""AEGIS self-curated suite (the original 48 attacks + 500 benign).

These are the cases reviewers correctly criticized as "in-distribution" —
they were authored alongside the 22 detection patterns. We KEEP them in the
benchmark but tag them `Distribution.IN_DIST` so all results can be reported
separately from public near/far-OOD splits. This honesty is part of the
revised evaluation story.

Raw layout (extracted from packages/gateway-mcp/src/__tests__/bypass-attacks.test.ts
by `scripts/extract_aegis_self.py`):
    research/benchmark/data/raw/aegis-self/
        attacks.jsonl
        benign.jsonl
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
    "sql": AttackCategory.SQL_INJECTION,
    "path": AttackCategory.PATH_TRAVERSAL,
    "shell": AttackCategory.SHELL_INJECTION,
    "prompt": AttackCategory.PROMPT_INJECTION,
    "sensitive": AttackCategory.SENSITIVE_FILE,
    "exfil": AttackCategory.DATA_EXFILTRATION,
    "pii": AttackCategory.PII_LEAKAGE,
}


@register_loader("aegis_self")
class AegisSelfLoader(BaseLoader):
    def iter_records(self) -> Iterable[BenchRecord]:
        for fname, label in [("attacks.jsonl", Label.MALICIOUS),
                             ("benign.jsonl", Label.BENIGN)]:
            path = self.root / fname
            if not path.exists():
                continue
            with path.open() as f:
                for raw in f:
                    rec = json.loads(raw)
                    cat_key = (rec.get("category") or "").lower()
                    category = next(
                        (v for k, v in _CATEGORY_MAP.items() if k in cat_key), None
                    )
                    yield BenchRecord(
                        id=f"aegis-self::{rec['id']}",
                        source="aegis_self",
                        label=label,
                        category=category if label == Label.MALICIOUS else None,
                        tool_call=ToolCall(
                            tool_name=rec.get("tool_name", "execute_sql"),
                            arguments=rec.get("arguments", {}),
                            framework="aegis-test-suite",
                        ),
                        conversation=[],
                        distribution=Distribution.IN_DIST,
                        granularity=Granularity.COARSE,
                        meta={"original_id": rec.get("id")},
                    )
