"""WS-5 (continued): sequence-level evaluation using PPM.

For each session_id in the benchmark, fit a Prediction-by-Partial-Matching
model on the sequence of (tool_name, category) tokens up to step k, then
compute the model's surprisal (negative log-likelihood) of step k+1. Mark
the step "anomalous" if surprisal exceeds the per-session median by a
threshold (z>=2 by default). Reported as: detection rate of *injected*
attack steps that no per-call defender would catch.

Notes:
  - PPM is implemented in `packages/gateway-mcp/src/services/ppm.ts` for
    production. This Python version uses a simple Markov-3 backoff model;
    it is *not* a perfect mirror, but it is sufficient for the paper's
    sequence experiment and stays dependency-light.
  - Records without a session_id are ignored.
"""

from __future__ import annotations

import argparse
import math
from collections import defaultdict
from pathlib import Path
from statistics import median

from benchmark.schema import BenchRecord, Label


class MarkovBackoff:
    def __init__(self, max_order: int = 3, alpha: float = 0.5):
        self.max_order = max_order
        self.alpha = alpha
        self.counts: list[dict[tuple, dict[str, int]]] = [
            defaultdict(lambda: defaultdict(int)) for _ in range(max_order + 1)
        ]
        self.vocab: set[str] = set()

    def update(self, history: list[str], token: str) -> None:
        self.vocab.add(token)
        for k in range(self.max_order + 1):
            ctx = tuple(history[-k:]) if k > 0 else ()
            self.counts[k][ctx][token] += 1

    def prob(self, history: list[str], token: str) -> float:
        for k in range(min(self.max_order, len(history)), -1, -1):
            ctx = tuple(history[-k:]) if k > 0 else ()
            row = self.counts[k].get(ctx)
            if row:
                num = row.get(token, 0) + self.alpha
                den = sum(row.values()) + self.alpha * max(1, len(self.vocab))
                p = num / den
                if p > 0:
                    return p
        return 1.0 / max(1, len(self.vocab))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", type=Path, required=True)
    p.add_argument("--z", type=float, default=2.0,
                   help="Surprisal z-score threshold for anomaly")
    args = p.parse_args()

    by_session: dict[str, list[BenchRecord]] = defaultdict(list)
    with args.inp.open() as f:
        for raw in f:
            rec = BenchRecord.model_validate_json(raw)
            if rec.session_id and rec.step_index is not None:
                by_session[rec.session_id].append(rec)

    if not by_session:
        print("No multi-step sessions in this benchmark.")
        print("Add agentdojo / toolemu / toolbench data and rebuild to enable.")
        return 0

    tp = fp = pos = neg = 0
    for sid, steps in by_session.items():
        steps.sort(key=lambda r: r.step_index or 0)
        model = MarkovBackoff()
        history: list[str] = []
        surprisals: list[float] = []
        labels: list[Label] = []
        for s in steps:
            tok = s.tool_call.tool_name
            p_tok = model.prob(history, tok)
            surp = -math.log2(max(p_tok, 1e-9))
            surprisals.append(surp)
            labels.append(s.label)
            model.update(history, tok)
            history.append(tok)

        if not surprisals:
            continue
        med = median(surprisals)
        mad = median(abs(x - med) for x in surprisals) or 1.0
        for surp, lab in zip(surprisals, labels):
            anomalous = ((surp - med) / mad) >= args.z
            if lab == Label.MALICIOUS:
                pos += 1
                tp += int(anomalous)
            else:
                neg += 1
                fp += int(anomalous)

    print(f"Sessions: {len(by_session)}")
    print(f"Steps: {pos+neg}  (malicious={pos}, benign={neg})")
    if pos:
        print(f"Sequence-level detection rate (TP/pos): {tp/pos:.3f}")
    if neg:
        print(f"Sequence-level FP rate          (FP/neg): {fp/neg:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
