"""WS-5: produce granularity-stratified slices of the benchmark.

Coarse-grained tools = single string-bearing argument that is the entire
operation (e.g. execute_sql(query: str), run_shell(cmd: str), read_file(path: str)).
Fine-grained tools = typed multi-argument schema (e.g. send_email(to, subject,
body) where each field is constrained).

We label each record automatically: if the only argument is a long free-form
string, it is COARSE; if there are >= 2 typed fields with bounded length, it
is FINE. Records with `granularity != UNKNOWN` already (e.g. agentdojo) are
respected.

Output: two JSONL files, plus a per-source crosstab.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from benchmark.schema import BenchRecord, Granularity


def _classify(rec: BenchRecord) -> Granularity:
    if rec.granularity != Granularity.UNKNOWN:
        return rec.granularity
    args = rec.tool_call.arguments or {}
    if not args:
        return Granularity.UNKNOWN
    if len(args) == 1:
        v = next(iter(args.values()))
        if isinstance(v, str) and len(v) > 30:
            return Granularity.COARSE
    typed_fields = sum(
        1 for v in args.values()
        if not isinstance(v, str) or len(v) <= 80
    )
    if typed_fields >= 2:
        return Granularity.FINE
    return Granularity.COARSE


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", type=Path, required=True)
    p.add_argument("--out-dir", type=Path, required=True)
    args = p.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    by_gran = {Granularity.COARSE: [], Granularity.FINE: [], Granularity.UNKNOWN: []}
    crosstab: Counter = Counter()
    with args.inp.open() as f:
        for raw in f:
            rec = BenchRecord.model_validate_json(raw)
            g = _classify(rec)
            by_gran[g].append(rec)
            crosstab[(rec.source, g.value, rec.label.value)] += 1

    for g, recs in by_gran.items():
        out = args.out_dir / f"slice-{g.value}.jsonl"
        with out.open("w") as f:
            for r in recs:
                f.write(r.model_dump_json() + "\n")
        print(f"  {g.value:>10}: {len(recs):>5} -> {out}")

    print("\nCrosstab (source, granularity, label) counts:")
    for k, v in sorted(crosstab.items()):
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
