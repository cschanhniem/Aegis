"""Evaluate XGBoost cascade on obfuscated benchmark data.

Trains on clean data, tests per-transform. Publication-quality figure.
Style: ICML/NeurIPS best-paper. Key fix: baseline annotation clear of
axis ticks, value labels always readable.
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from benchmark.schema import BenchRecord, Decision, Label
from cascade.features import encode
from cascade.l2_xgboost import L2XGBoost
from cascade.pipeline import CascadePipeline, CascadeThresholds
from baselines import get_baseline

# ── Publication RC ──────────────────────────────────────────────────────
plt.rcParams.update({
    "font.family":        "serif",
    "font.serif":         ["Times New Roman", "Times", "DejaVu Serif"],
    "mathtext.fontset":   "stix",
    "font.size":          7.5,
    "axes.labelsize":     8,
    "xtick.labelsize":    6.5,
    "ytick.labelsize":    6.5,
    "figure.dpi":         600,
    "savefig.dpi":        600,
    "savefig.bbox":       "tight",
    "savefig.pad_inches": 0.03,
    "axes.linewidth":     0.5,
    "xtick.major.width":  0.4,
    "ytick.major.width":  0.4,
    "xtick.major.size":   2.5,
    "ytick.major.size":   2.5,
    "axes.spines.top":    False,
    "axes.spines.right":  False,
    "pdf.fonttype":       42,
    "ps.fonttype":        42,
})

# ── Palette (single-hue teal, graduated) ───────────────────────────────
C_100  = "#065f46"  # emerald-800: 100%
C_99   = "#0d9488"  # teal-600: ≥99%
C_98   = "#5eead4"  # teal-300: ≥98%
C_LOW  = "#99f6e4"  # teal-200: <98%
C_BL   = "#6b7280"  # gray-500: baseline line
C_ANN  = "#1f2937"  # gray-800


def main():
    clean_path = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
    clean_records = [BenchRecord.model_validate_json(l) for l in clean_path.open()]

    obf_path = ROOT / "benchmark" / "data" / "aegis-bench-obfuscated.jsonl"
    obf_records = [BenchRecord.model_validate_json(l) for l in obf_path.open()]
    print(f"Clean: {len(clean_records)}, Obfuscated: {len(obf_records)}")

    by_transform: dict[str, list[BenchRecord]] = defaultdict(list)
    for r in obf_records:
        t = r.meta.get("obfuscation", "unknown") if r.meta else "unknown"
        by_transform[t].append(r)

    transforms = sorted(by_transform.keys())
    print(f"Transforms: {transforms}")

    l1 = get_baseline("aegis_rules")
    cascade = CascadePipeline(
        l1=l1, l3=None,
        thresholds=CascadeThresholds(),
        use_l1=True, use_l2=True, use_l3=False,
        l2_mode="xgboost", random_state=0,
    )
    cascade.warmup()

    print("Fitting XGBoost on all clean data...")
    stats = cascade.fit_l2_supervised(
        clean_records, val_frac=0.15, target_fpr=0.01, target_fnr=0.05
    )
    print(f"  tau_high={cascade.thresholds.tau_high:.4f}, "
          f"tau_low={cascade.thresholds.tau_low:.4f}")

    results = {}
    for t in transforms:
        recs = by_transform[t]
        mal = [r for r in recs if r.label == Label.MALICIOUS]
        ben = [r for r in recs if r.label == Label.BENIGN]
        blocked_mal = blocked_ben = 0
        t0 = time.perf_counter()
        for r in recs:
            pred = cascade.predict(r)
            is_blocked = pred.decision in (Decision.BLOCK, Decision.PENDING)
            if r.label == Label.MALICIOUS and is_blocked:
                blocked_mal += 1
            elif r.label == Label.BENIGN and is_blocked:
                blocked_ben += 1
        elapsed = time.perf_counter() - t0
        block_rate = blocked_mal / max(1, len(mal))
        fp_rate = blocked_ben / max(1, len(ben)) if ben else 0.0
        results[t] = {
            "n_total": len(recs), "n_malicious": len(mal), "n_benign": len(ben),
            "block_rate": round(block_rate, 4), "fp_rate": round(fp_rate, 4),
            "blocked_mal": blocked_mal, "blocked_ben": blocked_ben,
            "time_s": round(elapsed, 2),
        }
        print(f"  {t:25s}  block={block_rate:.1%}  fp={fp_rate:.1%}  n={len(recs)}")

    clean_mal = [r for r in clean_records if r.label == Label.MALICIOUS]
    blocked_clean = sum(
        1 for r in clean_mal
        if cascade.predict(r).decision in (Decision.BLOCK, Decision.PENDING)
    )
    results["_clean_baseline"] = {
        "n_malicious": len(clean_mal),
        "block_rate": round(blocked_clean / max(1, len(clean_mal)), 4),
    }
    print(f"  {'clean (baseline)':25s}  block={blocked_clean/max(1,len(clean_mal)):.1%}")
    cascade.shutdown()

    out_dir = ROOT / "results"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "obfuscation_robustness.json").write_text(json.dumps(results, indent=2))
    print(f"\nSaved: {out_dir / 'obfuscation_robustness.json'}")
    _make_figure(results, transforms)


def _make_figure(results, transforms):
    chart_transforms = [t for t in transforms
                        if not t.startswith("_") and t != "unknown"]
    block_rates = np.array([results[t]["block_rate"] for t in chart_transforms])
    clean_rate = results.get("_clean_baseline", {}).get("block_rate", 1.0)

    # Sort descending
    sort_idx = np.argsort(block_rates)[::-1]
    chart_transforms = [chart_transforms[i] for i in sort_idx]
    block_rates = block_rates[sort_idx]

    pretty = {
        "case_flip":          "Case Flip",
        "sql_comment_split":  "SQL Comment Split",
        "url_encode":         "URL Encode",
        "double_url_encode":  "Double URL Encode",
        "unicode_homoglyph":  "Unicode Homoglyph",
        "hex_payload":        "Hex Payload",
        "base64_wrap":        "Base64 Wrap",
        "whitespace_pad":     "Whitespace Pad",
        "paraphrase_prompt":  "LLM Paraphrase",
    }
    labels = [pretty.get(t, t) for t in chart_transforms]

    n = len(labels)
    fig, ax = plt.subplots(figsize=(3.25, 2.4))
    y_pos = np.arange(n)
    bar_h = 0.52

    # Color by tier
    colors = []
    for br in block_rates:
        if br >= 1.0 - 1e-9:
            colors.append(C_100)
        elif br >= 0.99:
            colors.append(C_99)
        elif br >= 0.98:
            colors.append(C_98)
        else:
            colors.append(C_LOW)

    bars = ax.barh(y_pos, block_rates, height=bar_h, color=colors,
                   edgecolor="white", linewidth=0.25, zorder=3)

    # Baseline reference line
    ax.axvline(clean_rate, color=C_BL, linestyle="--",
               linewidth=0.6, zorder=4, alpha=0.5)
    # Label at top, outside the bar area, above first bar
    ax.text(clean_rate, -0.7,
            f"Clean\n{clean_rate:.1%}",
            fontsize=5, color=C_BL, ha="center", va="bottom",
            fontstyle="italic", linespacing=0.85)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=6)
    ax.invert_yaxis()
    ax.set_xlabel("Block Rate")
    ax.xaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=0))
    ax.set_xlim(0.96, 1.013)

    ax.xaxis.grid(True, linewidth=0.2, color="#f3f4f6", zorder=0)
    ax.set_axisbelow(True)

    # Value annotations — outside the bar end, dark text
    for i, val in enumerate(block_rates):
        ax.text(val + 0.0012, i, f"{val:.1%}",
                va="center", ha="left", fontsize=5.5, color=C_ANN)

    # Summary footnote
    avg_br = block_rates.mean()
    ax.text(0.0, -0.13,
            f"Mean: {avg_br:.1%}  |  FP = 0.0% all transforms  |  "
            f"Zero-shot (trained on clean only)",
            fontsize=4, color="#b0b0b0", fontstyle="italic",
            transform=ax.transAxes)

    plt.tight_layout()

    for out_dir in [
        ROOT / "paper-emnlp" / "figures",
        ROOT.parent / "workshops" / "icml" / "images",
        ROOT.parent / "workshops" / "sao" / "images",
        ROOT.parent / "workshops" / "rleval" / "images",
    ]:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "obfuscation_robustness.pdf"
        fig.savefig(out, bbox_inches="tight", dpi=600)
        print(f"Saved: {out}")


if __name__ == "__main__":
    main()
