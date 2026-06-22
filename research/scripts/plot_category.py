"""Per-category block rate bar chart from XGBoost cascade results.

Style: ICML/NeurIPS best-paper quality.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

ROOT = Path(__file__).resolve().parents[1]

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

C_100  = "#065f46"
C_HIGH = "#0d9488"
C_MED  = "#f59e0b"
C_LOW  = "#ef4444"


def main():
    # Load best XGBoost cascade summary
    run_dirs = sorted(ROOT.glob("results/cascade-xgb-haiku*"))
    if not run_dirs:
        print("No xgb-haiku results found")
        return
    summary = json.loads((run_dirs[-1] / "summary.json").read_text())
    by_cat = summary["by_category"]

    # Pretty names and sort by count desc
    pretty = {
        "sql_injection":       "SQL Injection",
        "path_traversal":      "Path Traversal",
        "sensitive_file":      "Sensitive File",
        "shell_injection":     "Shell Injection",
        "prompt_injection":    "Prompt Injection",
        "unauthorized_action": "Unauth. Action",
        "data_exfiltration":   "Data Exfiltration",
        "pii_leakage":         "PII Leakage",
        "uncategorized":       "Uncategorized",
    }

    cats = sorted(by_cat.keys(), key=lambda c: -by_cat[c]["n"])
    labels = [pretty.get(c, c) for c in cats]
    rates = [by_cat[c]["block_rate"] for c in cats]
    counts = [by_cat[c]["n"] for c in cats]

    fig, ax = plt.subplots(figsize=(3.4, 2.4))
    n = len(cats)
    y_pos = np.arange(n)
    bar_h = 0.55

    colors = []
    for r in rates:
        if r >= 1.0 - 1e-9:
            colors.append(C_100)
        elif r >= 0.9:
            colors.append(C_HIGH)
        elif r >= 0.7:
            colors.append(C_MED)
        else:
            colors.append(C_LOW)

    bars = ax.barh(y_pos, rates, height=bar_h, color=colors,
                   edgecolor="white", linewidth=0.25, zorder=3)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=6)
    ax.invert_yaxis()
    ax.set_xlabel("Block Rate")
    ax.xaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=0))
    ax.set_xlim(0, 1.12)

    ax.xaxis.grid(True, linewidth=0.2, color="#f3f4f6", zorder=0)
    ax.set_axisbelow(True)

    # Annotations: rate + count
    for i, (rate, count) in enumerate(zip(rates, counts)):
        pct = f"{rate:.0%}" if rate >= 0.995 else f"{rate:.1%}"
        ax.text(rate + 0.012, i, f"{pct}  (n={count})",
                va="center", ha="left", fontsize=5.5, color="#374151")

    plt.tight_layout()

    for out_dir in [
        ROOT / "paper-emnlp" / "figures",
        ROOT.parent / "workshops" / "icml" / "images",
        ROOT.parent / "workshops" / "sao" / "images",
        ROOT.parent / "workshops" / "rleval" / "images",
    ]:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "category_blockrate.pdf"
        fig.savefig(out, bbox_inches="tight", dpi=600)
        print(f"Saved: {out}")


if __name__ == "__main__":
    main()
