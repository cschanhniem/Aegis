"""Analyze misclassified cases from the best XGBoost cascade run.

Finds false negatives (missed attacks) and false positives (benign blocked),
outputs a qualitative summary for the paper's error analysis section.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from benchmark.schema import BenchRecord, Label


def main():
    # Find the best xgb+haiku run
    results_dir = ROOT / "results"
    xgb_runs = sorted(results_dir.glob("cascade-xgb-haiku*"))
    if not xgb_runs:
        print("No xgb-haiku cascade runs found. Trying any xgb run...")
        xgb_runs = sorted(results_dir.glob("*xgboost*"))
    if not xgb_runs:
        print("ERROR: No XGBoost cascade results found.")
        return

    run_dir = xgb_runs[-1]  # latest
    print(f"Analyzing: {run_dir.name}")

    pred_path = run_dir / "predictions.jsonl"
    preds = [json.loads(l) for l in pred_path.open()]
    pred_map = {p["record_id"]: p for p in preds}

    # Load benchmark for ground truth
    bench_path = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
    records = {r.id: r for r in
               (BenchRecord.model_validate_json(l) for l in bench_path.open())}

    fn_cases = []  # false negatives: malicious but ALLOW
    fp_cases = []  # false positives: benign but BLOCK

    for pid, pred in pred_map.items():
        if pid not in records:
            continue
        rec = records[pid]
        decision = pred["decision"]
        is_blocked = decision in ("block", "pending")

        if rec.label == Label.MALICIOUS and not is_blocked:
            fn_cases.append((rec, pred))
        elif rec.label == Label.BENIGN and is_blocked:
            fp_cases.append((rec, pred))

    print(f"\n=== FALSE NEGATIVES (missed attacks): {len(fn_cases)} ===")
    fn_by_cat = Counter()
    fn_by_source = Counter()
    fn_by_layer = Counter()
    for rec, pred in fn_cases:
        fn_by_cat[rec.category or "uncategorized"] += 1
        fn_by_source[rec.source] += 1
        fn_by_layer[pred.get("layer_fired", "none")] += 1

    print(f"  By category: {dict(fn_by_cat)}")
    print(f"  By source:   {dict(fn_by_source)}")
    print(f"  By layer:    {dict(fn_by_layer)}")

    print(f"\n  Sample FN cases (up to 5):")
    for rec, pred in fn_cases[:5]:
        tc = rec.tool_call
        args_str = json.dumps(tc.arguments or {})[:120]
        print(f"    id={rec.id}")
        print(f"    tool={tc.tool_name}, category={rec.category}, source={rec.source}")
        print(f"    args={args_str}")
        print(f"    layer={pred.get('layer_fired')}, score={pred.get('risk_score', '?'):.3f}")
        print(f"    rationale={pred.get('rationale', '')[:100]}")
        print()

    print(f"\n=== FALSE POSITIVES (benign blocked): {len(fp_cases)} ===")
    fp_by_layer = Counter()
    for rec, pred in fp_cases:
        fp_by_layer[pred.get("layer_fired", "none")] += 1

    print(f"  By layer: {dict(fp_by_layer)}")

    print(f"\n  Sample FP cases (up to 5):")
    for rec, pred in fp_cases[:5]:
        tc = rec.tool_call
        args_str = json.dumps(tc.arguments or {})[:120]
        print(f"    id={rec.id}")
        print(f"    tool={tc.tool_name}, source={rec.source}")
        print(f"    args={args_str}")
        print(f"    layer={pred.get('layer_fired')}, score={pred.get('risk_score', '?'):.3f}")
        print(f"    rationale={pred.get('rationale', '')[:100]}")
        print()

    # Save analysis
    analysis = {
        "run": run_dir.name,
        "total_predictions": len(preds),
        "false_negatives": {
            "count": len(fn_cases),
            "by_category": dict(fn_by_cat),
            "by_source": dict(fn_by_source),
            "by_layer": dict(fn_by_layer),
            "examples": [
                {
                    "id": rec.id,
                    "tool": rec.tool_call.tool_name,
                    "category": rec.category,
                    "source": rec.source,
                    "score": pred.get("risk_score"),
                    "layer": pred.get("layer_fired"),
                }
                for rec, pred in fn_cases[:10]
            ],
        },
        "false_positives": {
            "count": len(fp_cases),
            "by_layer": dict(fp_by_layer),
            "examples": [
                {
                    "id": rec.id,
                    "tool": rec.tool_call.tool_name,
                    "source": rec.source,
                    "score": pred.get("risk_score"),
                    "layer": pred.get("layer_fired"),
                }
                for rec, pred in fp_cases[:10]
            ],
        },
    }
    out = ROOT / "results" / "error_analysis.json"
    out.write_text(json.dumps(analysis, indent=2))
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
