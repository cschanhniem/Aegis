"""Plot the cost-vs-block-rate Pareto frontier from pareto_data.csv.

Style target: ICML/NeurIPS best-paper quality.

Layout strategy for label clarity:
  - Merge the two XGB cascade points (nearly identical coords) into one
    star with a single label.
  - The top-right LLM cluster labels are placed in a vertical stack to
    the LEFT of the cluster, connected by thin lines, so they never
    overlap each other or the data.
  - Bottom points get simple right-side labels.
"""

from __future__ import annotations

import csv
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "paper-emnlp" / "figures" / "pareto_data.csv"

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

C_OURS = "#b91c1c"
C_LLM  = "#3730a3"
C_BASE = "#6b7280"
C_GRID = "#f3f4f6"

_ARROW = dict(arrowstyle="-", color="#c0c0c0", linewidth=0.35,
              shrinkA=0, shrinkB=2)


def _pareto_front(points):
    pts = sorted(points, key=lambda p: (p[0], -p[1]))
    front, best = [], -1.0
    for x, y, *_ in pts:
        if y > best:
            front.append((x, y))
            best = y
    return front


def main() -> int:
    rows = list(csv.DictReader(DEFAULT_CSV.open()))

    data = {}
    for r in rows:
        try:
            x = float(r["p50_ms"]); y = float(r["block_rate"]) * 100
        except (KeyError, ValueError):
            continue
        if y == 0 and x == 0:
            continue
        data[r["defender"]] = (x, y)

    # ── Merge XGB variants into one representative point ────────────────
    xgb_h = data.pop("AEGIS (XGB+Haiku)")
    xgb_g = data.pop("AEGIS (XGB+GPT-4o)")
    xgb_merged = ((xgb_h[0] + xgb_g[0]) / 2, (xgb_h[1] + xgb_g[1]) / 2)

    fig, ax = plt.subplots(figsize=(3.5, 2.7))

    # ── Pareto frontier ─────────────────────────────────────────────────
    all_pts = list(data.values()) + [xgb_merged]
    front = _pareto_front([(x, y) for x, y in all_pts])
    if len(front) >= 2:
        ax.plot([p[0] for p in front], [p[1] for p in front],
                color="#e5e7eb", linewidth=0.7, zorder=1)

    # ── Plot helper ─────────────────────────────────────────────────────
    def pt(name, x, y, marker, color, size, label_text,
           ldx, ldy, lha="left", lva="center", bold=False, fsize=5.5):
        ax.scatter(x, y, s=size, c=color, marker=marker,
                   edgecolor="white", linewidth=0.3, zorder=5)
        fw = "bold" if bold else "normal"
        use_arrow = (ldx**2 + ldy**2) > 100
        ax.annotate(
            label_text, (x, y),
            xytext=(ldx, ldy), textcoords="offset points",
            fontsize=fsize, fontweight=fw, color=color,
            ha=lha, va=lva, linespacing=0.9,
            arrowprops=_ARROW if use_arrow else None,
        )

    # ── AEGIS XGB (merged star) — the hero point ───────────────────────
    pt("XGB", xgb_merged[0], xgb_merged[1],
       "*", C_OURS, 140,
       "AEGIS Cascade\n(XGB + LLM Judge)",
       ldx=10, ldy=6, lha="left", lva="bottom", bold=True, fsize=6)

    # ── IForest cascade ────────────────────────────────────────────────
    ifx, ify = data["AEGIS (IForest+Haiku)"]
    pt("IF", ifx, ify,
       "D", C_OURS, 35,
       "AEGIS (IForest)",
       ldx=-10, ldy=-10, lha="right", lva="top", fsize=5.5)

    # ── AEGIS rules ────────────────────────────────────────────────────
    rx, ry = data["AEGIS-rules (L1)"]
    pt("R", rx, ry,
       "s", C_OURS, 28,
       "AEGIS-rules\n(L1 only)",
       ldx=8, ldy=6, lha="left", lva="bottom", fsize=5)

    # ── Keyword blacklist ──────────────────────────────────────────────
    kx, ky = data["Keyword blacklist"]
    pt("K", kx, ky,
       "v", C_BASE, 25,
       "Keyword\nblacklist",
       ldx=8, ldy=0, lha="left", lva="center", fsize=5)

    # ── Llama-Guard ────────────────────────────────────────────────────
    lx, ly = data["Llama-Guard-3"]
    pt("L", lx, ly,
       "^", C_BASE, 30,
       "Llama-Guard-3",
       ldx=8, ldy=-6, lha="left", lva="top", fsize=5.5)

    # ── LLM judges cluster — labels stacked to the LEFT ────────────────
    # Points sorted by y descending for label stacking
    llm_names = ["GPT-4o-mini", "Claude Haiku 4.5", "GPT-4o", "Claude Sonnet 4.6"]
    llm_pts = [(data[n][0], data[n][1], n) for n in llm_names]
    llm_pts.sort(key=lambda p: -p[1])  # highest y first

    # Stack labels at fixed x position (in data coords) left of the cluster
    # with even vertical spacing (in points)
    label_x_data = 350  # anchor x in data space (left of cluster)
    label_y_start = 102  # top of stack in data space
    label_y_step = 7    # points spacing between labels

    for i, (px, py, name) in enumerate(llm_pts):
        # Plot the point
        ax.scatter(px, py, s=28, c=C_LLM, marker="o",
                   edgecolor="white", linewidth=0.3, zorder=5)
        # Place label at stacked position
        label_y = label_y_start - i * label_y_step
        ax.annotate(
            name, (px, py),
            xytext=(label_x_data, label_y),
            textcoords="data",
            fontsize=5.5, color=C_LLM,
            ha="right", va="center",
            arrowprops=dict(arrowstyle="-", color="#d0d0d0",
                            linewidth=0.3, shrinkA=0, shrinkB=2),
        )

    # ── Axes ────────────────────────────────────────────────────────────
    ax.set_xscale("log")
    ax.set_xlabel("Latency P50 (ms)")
    ax.set_ylabel("Block Rate (%)")
    ax.set_ylim(-3, 108)
    ax.set_xlim(0.002, 8000)
    ax.yaxis.grid(True, linewidth=0.2, color=C_GRID, zorder=0)
    ax.xaxis.grid(True, linewidth=0.2, color=C_GRID, zorder=0)
    ax.set_axisbelow(True)

    # 90% reference line
    ax.axhline(90, color="#e5e7eb", linewidth=0.35, linestyle=":", zorder=0)
    ax.text(0.003, 91, "90%", fontsize=4.5, color="#d1d5db", va="bottom")

    plt.tight_layout()

    for out_dir in [
        ROOT / "paper-emnlp" / "figures",
        ROOT.parent / "workshops" / "icml" / "images",
        ROOT.parent / "workshops" / "sao" / "images",
        ROOT.parent / "workshops" / "rleval" / "images",
    ]:
        out_dir.mkdir(parents=True, exist_ok=True)
        fig.savefig(out_dir / "pareto.pdf", bbox_inches="tight", dpi=600)
        print(f"Saved: {out_dir / 'pareto.pdf'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
