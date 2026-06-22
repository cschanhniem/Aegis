"""AgentDojo loader.

Source: Debenedetti et al., 2024 — "AgentDojo: A Dynamic Environment to
Evaluate Prompt Injection Attacks and Defenses for LLM Agents".
Repo: https://github.com/ethz-spylab/agent-dojo

AgentDojo cases are *dynamic* — there is no static JSON of "tool calls". The
intended workflow is:
    1. pip install agentdojo
    2. run a benchmark loop with a chosen LLM/attack
    3. capture the tool-call traces

For reproducibility we ship a thin replay layer:
    research/benchmark/data/raw/agentdojo/traces.jsonl
where each line is {suite, user_task, injection_task, attack, tool_calls: [...]}
produced by `scripts/run_agentdojo.py` (see baselines/run_agentdojo.py).

If the trace file is absent, this loader yields nothing (no fabrication).
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

_SUITE_TO_FRAMEWORK = {
    "banking": "agentdojo-banking",
    "slack": "agentdojo-slack",
    "travel": "agentdojo-travel",
    "workspace": "agentdojo-workspace",
}


@register_loader("agentdojo")
class AgentDojoLoader(BaseLoader):
    def iter_records(self) -> Iterable[BenchRecord]:
        traces = self.root / "traces.jsonl"
        if not traces.exists():
            return
        with traces.open() as f:
            for line_no, raw in enumerate(f):
                trace = json.loads(raw)
                suite = trace.get("suite", "unknown")
                attack = trace.get("attack", "unknown")
                injection_task = trace.get("injection_task")
                user_task = trace.get("user_task", "")
                session = f"agentdojo::{suite}::{trace.get('id', line_no)}"
                for step, call in enumerate(trace.get("tool_calls", [])):
                    is_attack_step = bool(call.get("is_injection_payload"))
                    label = Label.MALICIOUS if is_attack_step else Label.BENIGN
                    category = (
                        AttackCategory.INDIRECT_INJECTION if is_attack_step else None
                    )
                    yield BenchRecord(
                        id=f"{session}::step{step}",
                        source="agentdojo",
                        label=label,
                        category=category,
                        tool_call=ToolCall(
                            tool_name=call.get("function", call.get("tool", "unknown")),
                            arguments=call.get("args", {}),
                            framework=_SUITE_TO_FRAMEWORK.get(suite, f"agentdojo-{suite}"),
                            model=trace.get("model"),
                        ),
                        conversation=[
                            {"role": "user", "content": user_task},
                        ],
                        session_id=session,
                        step_index=step,
                        distribution=Distribution.FAR_OOD,
                        granularity=Granularity.FINE,
                        meta={
                            "suite": suite,
                            "attack": attack,
                            "injection_task": injection_task,
                            "license": "AGPL-3.0",
                        },
                    )
