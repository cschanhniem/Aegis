"""Extract XGBoost feature importances and generate bar chart for paper.

Style target: ICML/NeurIPS best-paper quality.
Design: compact horizontal bars, monospace labels at small size,
        top feature visually dominant, zero-importance features noted.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from benchmark.schema import BenchRecord, Label
from cascade.l2_xgboost import L2XGBoost

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

C_TOP  = "#1e40af"  # blue-800: top feature
C_HIGH = "#3b82f6"  # blue-500: rank 2-5
C_LOW  = "#bfdbfe"  # blue-200: rank 6+
C_ANN  = "#374151"  # gray-700
C_ANN2 = "#9ca3af"  # gray-400


def main():
    bench_path = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
    records = [BenchRecord.model_validate_json(l) for l in bench_path.open()]

    model = L2XGBoost(n_estimators=300, max_depth=6, random_state=0)
    stats = model.fit(records, val_frac=0.15, calibrate=True)

    importances = stats["feature_importances"]
    print(json.dumps(importances, indent=2))

    names = list(importances.keys())
    values = np.array([importances[n] for n in names])
    order = np.argsort(values)[::-1]
    sorted_names = [names[i] for i in order]
    sorted_vals  = values[order]

    # Keep only nonzero
    nz_mask = sorted_vals > 0
    nz_names = [n for n, m in zip(sorted_names, nz_mask) if m]
    nz_vals  = sorted_vals[nz_mask]
    n_zero = int((~nz_mask).sum())
    zero_names = [n for n, m in zip(sorted_names, nz_mask) if not m]

    # Display names — keep code-style for paper credibility
    display = {
        "total_arg_chars":      "total_arg_chars",
        "longest_run_same_char":"longest_run",
        "shannon_entropy":      "shannon_entropy",
        "punct_ratio":          "punct_ratio",
        "arg_count":            "arg_count",
        "digit_ratio":          "digit_ratio",
        "url_count":            "url_count",
        "uppercase_ratio":      "uppercase_ratio",
        "has_path_separator":   "has_path_sep",
    }
    labels = [display.get(n, n) for n in nz_names]

    # ── Figure ──────────────────────────────────────────────────────────
    n = len(labels)
    fig, ax = plt.subplots(figsize=(3.25, 2.2))

    y_pos = np.arange(n)
    bar_h = 0.55

    colors = []
    for i in range(n):
        if i == 0:
            colors.append(C_TOP)
        elif i < 5:
            colors.append(C_HIGH)
        else:
            colors.append(C_LOW)

    bars = ax.barh(y_pos, nz_vals, height=bar_h, color=colors,
                   edgecolor="white", linewidth=0.25, zorder=3)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontfamily="monospace", fontsize=5.8)
    ax.invert_yaxis()
    ax.set_xlabel("Feature Importance (Gain)")
    ax.xaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=0))
    ax.set_xlim(0, max(nz_vals) * 1.16)

    # Faint x-grid
    ax.xaxis.grid(True, linewidth=0.2, color="#f3f4f6", zorder=0)
    ax.set_axisbelow(True)

    # Value annotations
    for i, val in enumerate(nz_vals):
        if val >= 0.01:
            ax.text(val + max(nz_vals) * 0.012, i,
                    f"{val:.1%}", va="center", fontsize=5.5,
                    color=C_ANN)
        else:
            ax.text(val + max(nz_vals) * 0.012, i,
                    f"{val:.2%}", va="center", fontsize=5,
                    color=C_ANN2)

    # Footnote
    if n_zero > 0:
        zero_display = {
            "max_string_depth": "max_string_depth",
            "ip_literal_count": "ip_literal_count",
            "json_depth": "json_depth",
            "has_curly_braces": "has_curly_braces",
            "base64_like_score": "base64_like",
            "hex_like_score": "hex_like",
        }
        zn = [zero_display.get(n, n) for n in zero_names]
        note = f"{n_zero} features with zero importance omitted: " + ", ".join(zn)
        ax.text(0.0, -0.12, note, fontsize=4, color="#b0b0b0",
                fontstyle="italic", transform=ax.transAxes)

    plt.tight_layout()

    for out_dir in [
        ROOT / "paper-emnlp" / "figures",
        ROOT.parent / "workshops" / "icml" / "images",
        ROOT.parent / "workshops" / "sao" / "images",
        ROOT.parent / "workshops" / "rleval" / "images",
    ]:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "feature_importance.pdf"
        fig.savefig(out, bbox_inches="tight", dpi=600)
        print(f"Saved: {out}")

    json_out = ROOT / "results" / "feature_importances.json"
    json_out.write_text(json.dumps({
        "importances": importances,
        "sorted": list(zip(sorted_names, sorted_vals.tolist())),
        "n_records": len(records),
    }, indent=2))
    print(f"Saved: {json_out}")


if __name__ == "__main__":
    main()
