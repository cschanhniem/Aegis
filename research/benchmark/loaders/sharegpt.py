"""ShareGPT / LMSYS-Chat-1M tool-use subset loader (BENIGN).

We sample real production agent traffic from public chat logs that contain
function/tool calls. Two supported sources:

  1. ShareGPT-FunctionCalls subset, prepared into JSONL with one record per
     tool call:
        {"tool_name": "...", "arguments": {...}, "user_query": "...",
         "model": "...", "id": "..."}
  2. LMSYS-Chat-1M filtered to conversations with `function_call` blocks
     (also normalized to the same JSONL).

Both produce far-OOD benign records — the ground truth is "no enforcement
should fire". Used as the headline FP-rate denominator.
"""

from __future__ import annotations

import json
from typing import Iterable

from ..schema import BenchRecord, Distribution, Granularity, Label, ToolCall
from .base import BaseLoader, register_loader


@register_loader("sharegpt")
class ShareGPTLoader(BaseLoader):
    def iter_records(self) -> Iterable[BenchRecord]:
        path = self.root / "tool_calls.jsonl"
        if not path.exists():
            return
        with path.open() as f:
            for raw in f:
                rec = json.loads(raw)
                yield BenchRecord(
                    id=f"sharegpt::{rec['id']}",
                    source="sharegpt",
                    label=Label.BENIGN,
                    tool_call=ToolCall(
                        tool_name=rec.get("tool_name", "unknown"),
                        arguments=rec.get("arguments", {}),
                        framework=rec.get("framework", "openai-functions"),
                        model=rec.get("model"),
                    ),
                    conversation=[
                        {"role": "user", "content": rec.get("user_query", "")}
                    ],
                    distribution=Distribution.FAR_OOD,
                    granularity=Granularity.FINE,
                    meta={"license": rec.get("license", "ODC-BY")},
                )
