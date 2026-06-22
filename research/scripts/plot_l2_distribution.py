"""Plot L2 XGBoost score distribution for malicious vs benign tool calls.

Shows the bimodal separation: benign calls cluster near 0, malicious near 1,
with tau_low and tau_high thresholds marking the escalation zone.

Style target: ICML/NeurIPS best-paper quality.
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from benchmark.schema import BenchRecord, Label
from cascade.l2_xgboost import L2XGBoost
from cascade.features import encode

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

C_MAL = "#dc2626"   # red-600
C_BEN = "#2563eb"   # blue-600
C_TAU = "#d97706"   # amber-600
C_ESC = "#fef3c7"   # amber-50 (escalation zone fill)


def main():
    bench_path = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
    records = [BenchRecord.model_validate_json(l) for l in bench_path.open()]
    print(f"Loaded {len(records)} records")

    # Train model (same config as main cascade)
    model = L2XGBoost(n_estimators=300, max_depth=6, random_state=0)
    stats = model.fit(records, val_frac=0.15, calibrate=True)
    tau_h = stats["tau_high"]
    tau_l = stats["tau_low"]
    print(f"Thresholds: tau_low={tau_l:.4f}, tau_high={tau_h:.4f}")

    # Score ALL records (not just val set)
    X = np.vstack([encode(r.tool_call).vector for r in records])
    scores = model._model.predict_proba(X)[:, 1]
    labels = np.array([1 if r.label == Label.MALICIOUS else 0 for r in records])

    mal_scores = scores[labels == 1]
    ben_scores = scores[labels == 0]
    print(f"Malicious: {len(mal_scores)}, Benign: {len(ben_scores)}")

    # ── Figure ──────────────────────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(3.5, 2.2))

    bins = np.linspace(0, 1, 60)

    ax.hist(ben_scores, bins=bins, alpha=0.75, color=C_BEN,
            density=True, label=f"Benign ($n$={len(ben_scores)})", zorder=3)
    ax.hist(mal_scores, bins=bins, alpha=0.65, color=C_MAL,
            density=True, label=f"Malicious ($n$={len(mal_scores)})", zorder=3)

    # Escalation zone shading
    ax.axvspan(tau_l, tau_h, alpha=0.15, color=C_ESC, zorder=1,
               label="Escalation zone")

    # Threshold lines
    ax.axvline(tau_l, color=C_TAU, ls="--", lw=1.0, zorder=4)
    ax.axvline(tau_h, color=C_TAU, ls="--", lw=1.0, zorder=4)

    # Threshold labels
    ymax = ax.get_ylim()[1]
    ax.text(tau_l, ymax * 0.92, r"$\tau_l$", fontsize=7, color=C_TAU,
            ha="right", va="top", fontweight="bold")
    ax.text(tau_h, ymax * 0.92, r"$\tau_h$", fontsize=7, color=C_TAU,
            ha="left", va="top", fontweight="bold")

    # Zone annotations
    ax.text(tau_l / 2, ymax * 0.75, "AUTO\nALLOW", fontsize=5, color="#059669",
            ha="center", va="center", fontstyle="italic", alpha=0.7)
    ax.text((tau_l + tau_h) / 2, ymax * 0.75, "→ L3", fontsize=5.5,
            color=C_TAU, ha="center", va="center", fontweight="bold", alpha=0.7)
    ax.text((1 + tau_h) / 2, ymax * 0.75, "AUTO\nBLOCK", fontsize=5,
            color="#dc2626", ha="center", va="center", fontstyle="italic",
            alpha=0.7)

    ax.set_xlabel("L2 Score $P(\\mathrm{malicious})$")
    ax.set_ylabel("Density")
    ax.set_xlim(-0.02, 1.02)
    ax.legend(fontsize=5.5, frameon=False, loc="upper center",
              ncol=3, columnspacing=1.0)

    plt.tight_layout()

    for out_dir in [
        ROOT / "paper-emnlp" / "figures",
        ROOT.parent / "workshops" / "icml" / "images",
        ROOT.parent / "workshops" / "sao" / "images",
        ROOT.parent / "workshops" / "rleval" / "images",
        ROOT.parent / "workshops" / "agent-skills" / "images",
    ]:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "l2_score_distribution.pdf"
        fig.savefig(out, bbox_inches="tight", dpi=600)
        print(f"Saved: {out}")


if __name__ == "__main__":
    main()
