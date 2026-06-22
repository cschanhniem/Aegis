"""ToolBench loader (BENIGN tool calls).

Source: Qin et al., 2023 — "ToolLLM: Facilitating Large Language Models to
Master 16000+ Real-world APIs". Repo: https://github.com/OpenBMB/ToolBench

We use ToolBench's annotated G1/G2/G3 trajectories as a source of *real*
benign tool calls — distinctly *not* hardcoded demos. Each trajectory step
that contains a `function_call` becomes one BenchRecord.

Expected raw layout:
    research/benchmark/data/raw/toolbench/
        data/answer/G1_query.json
        data/answer/G2_query.json
        data/answer/G3_query.json
"""

from __future__ import annotations

import json
from typing import Iterable

from ..schema import (
    BenchRecord,
    Distribution,
    Granularity,
    Label,
    ToolCall,
)
from .base import BaseLoader, register_loader

_SPLITS = ["G1_query.json", "G2_query.json", "G3_query.json"]


@register_loader("toolbench")
class ToolBenchLoader(BaseLoader):
    def iter_records(self) -> Iterable[BenchRecord]:
        # ToolBench has many possible layouts; try a few.
        candidate_dirs = [
            self.root / "data" / "answer",
            self.root / "answer",
            self.root,
        ]
        base = next((d for d in candidate_dirs if d.exists()), None)
        if base is None:
            return
        for split in _SPLITS:
            path = base / split
            if not path.exists():
                continue
            with path.open() as f:
                items = json.load(f)
            for i, item in enumerate(items):
                trace = item.get("answer_generation", {}).get("train_messages", [])
                if not trace:
                    continue
                # ToolBench train_messages is a list-of-lists; flatten.
                msgs = trace[-1] if isinstance(trace[0], list) else trace
                user_query = item.get("query", "")
                session = f"toolbench::{split}::{i}"
                step = 0
                for msg in msgs:
                    fc = msg.get("function_call") if isinstance(msg, dict) else None
                    if not fc:
                        continue
                    args = fc.get("arguments", {})
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {"_raw": args}
                    yield BenchRecord(
                        id=f"{session}::step{step}",
                        source="toolbench",
                        label=Label.BENIGN,
                        tool_call=ToolCall(
                            tool_name=fc.get("name", "unknown"),
                            arguments=args if isinstance(args, dict) else {},
                            framework="toolbench-rapidapi",
                        ),
                        conversation=[{"role": "user", "content": user_query}],
                        session_id=session,
                        step_index=step,
                        distribution=Distribution.FAR_OOD,
                        granularity=Granularity.FINE,
                        meta={"split": split, "license": "Apache-2.0"},
                    )
                    step += 1
