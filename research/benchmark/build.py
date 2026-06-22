"""Unify per-source loaders into a single canonical JSONL.

Usage:
    python -m benchmark.build                       # build everything available
    python -m benchmark.build --sources injecagent toolbench
    python -m benchmark.build --out data/dev.jsonl  # custom output

The script never silently fabricates data: if a loader's raw root is missing,
it is reported as "skipped" with the path it expected.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .loaders import all_loaders, get_loader

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
DEFAULT_OUT = ROOT / "data" / "aegis-bench.jsonl"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", nargs="*", default=all_loaders())
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--raw-root", type=Path, default=RAW)
    args = parser.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    per_source: dict[str, int] = {}
    skipped: list[str] = []

    with args.out.open("w") as out:
        for name in args.sources:
            root = args.raw_root / name
            loader = get_loader(name, root)
            if not loader.is_available():
                skipped.append(f"{name} (expected raw at {root})")
                continue
            count = 0
            for rec in loader.iter_records():
                out.write(rec.model_dump_json() + "\n")
                count += 1
            per_source[name] = count
            written += count

    print(f"Wrote {written} records to {args.out}")
    for name, n in sorted(per_source.items()):
        print(f"  {name:>14}  {n:>7}")
    if skipped:
        print("\nSkipped (raw data not present):")
        for s in skipped:
            print(f"  - {s}")
        print("\nRun `python -m benchmark.scripts.download_all` to fetch them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
