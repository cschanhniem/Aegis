"""Print per-source / per-label / per-distribution stats from aegis-bench.jsonl."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", type=Path,
                   default=Path(__file__).resolve().parent / "data" / "aegis-bench.jsonl")
    args = p.parse_args()

    by_source: Counter = Counter()
    by_label: Counter = Counter()
    by_dist: Counter = Counter()
    by_cat: Counter = Counter()
    by_gran: Counter = Counter()
    sessions: set[str] = set()
    total = 0

    with args.inp.open() as f:
        for raw in f:
            r = json.loads(raw)
            total += 1
            by_source[r["source"]] += 1
            by_label[r["label"]] += 1
            by_dist[r["distribution"]] += 1
            by_gran[r["granularity"]] += 1
            if r.get("category"):
                by_cat[r["category"]] += 1
            if r.get("session_id"):
                sessions.add(r["session_id"])

    def show(title, c):
        print(f"\n{title}")
        for k, v in c.most_common():
            print(f"  {k:>22} {v:>7}")

    print(f"Total records: {total}")
    print(f"Distinct sessions (multi-step): {len(sessions)}")
    show("By source", by_source)
    show("By label", by_label)
    show("By distribution partition", by_dist)
    show("By tool granularity", by_gran)
    show("By attack category (malicious only)", by_cat)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
