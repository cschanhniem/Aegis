"""Threshold sensitivity analysis for XGBoost L2.

Sweeps tau_high and tau_low independently to show the block-rate vs FP
trade-off. Generates a two-panel figure:
  Left:  Block rate & FP rate vs tau_high (tau_low fixed)
  Right: Block rate & FP rate vs tau_low  (tau_high fixed)

Style: ICML/NeurIPS best-paper quality.
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

from benchmark.schema import BenchRecord, Decision, Label
from cascade.features import encode
from cascade.l2_xgboost import L2XGBoost

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

C_BLOCK = "#b91c1c"   # red-700
C_FP    = "#2563eb"   # blue-600
C_ESC   = "#9ca3af"   # gray-400
C_CAL   = "#059669"   # emerald-600


def main():
    bench_path = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
    records = [BenchRecord.model_validate_json(l) for l in bench_path.open()]

    # Train model on 50% split (same as main experiments)
    import random
    rng = random.Random(0)
    benign = [r for r in records if r.label == Label.BENIGN]
    malicious = [r for r in records if r.label == Label.MALICIOUS]
    rng.shuffle(benign); rng.shuffle(malicious)
    fit_n_b = len(benign) // 2; fit_n_m = len(malicious) // 2
    fit_set = benign[:fit_n_b] + malicious[:fit_n_m]
    fit_ids = {r.id for r in fit_set}
    test_set = [r for r in records if r.id not in fit_ids]

    model = L2XGBoost(n_estimators=300, max_depth=6, random_state=0)
    stats = model.fit(fit_set, val_frac=0.15, calibrate=True)
    cal_tau_h = stats["tau_high"]
    cal_tau_l = stats["tau_low"]
    print(f"Calibrated: tau_h={cal_tau_h:.4f}, tau_l={cal_tau_l:.4f}")

    # Score all test records
    test_mal = [r for r in test_set if r.label == Label.MALICIOUS]
    test_ben = [r for r in test_set if r.label == Label.BENIGN]
    mal_scores = np.array([model.score(r) for r in test_mal])
    ben_scores = np.array([model.score(r) for r in test_ben])
    print(f"Test: {len(test_mal)} mal, {len(test_ben)} ben")

    # ── Sweep tau_high (tau_low fixed at calibrated) ────────────────────
    tau_h_range = np.linspace(0.5, 1.0, 100)
    block_vs_h = []
    fp_vs_h = []
    esc_vs_h = []
    for th in tau_h_range:
        # blocked = score >= th
        blocked_mal = (mal_scores >= th).sum()
        blocked_ben = (ben_scores >= th).sum()
        # escalated = cal_tau_l <= score < th
        esc_mal = ((mal_scores >= cal_tau_l) & (mal_scores < th)).sum()
        block_vs_h.append(blocked_mal / len(mal_scores))
        fp_vs_h.append(blocked_ben / len(ben_scores))
        esc_vs_h.append(esc_mal / len(mal_scores))

    # ── Sweep tau_low (tau_high fixed at calibrated) ────────────────────
    tau_l_range = np.linspace(0.0, 0.5, 100)
    block_vs_l = []
    fp_vs_l = []
    esc_vs_l = []
    for tl in tau_l_range:
        # With fixed tau_h, blocked = score >= cal_tau_h
        # The question for tau_l: what fraction escapes to L3 vs auto-allowed?
        # auto-allowed = score < tl
        # escalated = tl <= score < cal_tau_h
        auto_allowed_mal = (mal_scores < tl).sum()  # missed by L2
        auto_allowed_ben = (ben_scores < tl).sum()
        esc_mal = ((mal_scores >= tl) & (mal_scores < cal_tau_h)).sum()
        block_vs_l.append(1.0 - auto_allowed_mal / len(mal_scores))  # L2 catch rate
        fp_vs_l.append(1.0 - auto_allowed_ben / len(ben_scores))  # benign NOT auto-allowed
        esc_vs_l.append(esc_mal / len(mal_scores))

    # ── Figure ──────────────────────────────────────────────────────────
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(6.8, 2.4), sharey=False)

    # Left: tau_high sweep
    ax1.plot(tau_h_range, block_vs_h, color=C_BLOCK, linewidth=1.2,
             label="Block rate (mal.)")
    ax1.plot(tau_h_range, fp_vs_h, color=C_FP, linewidth=1.2,
             label="FP rate (ben.)")
    ax1.plot(tau_h_range, esc_vs_h, color=C_ESC, linewidth=0.8,
             linestyle=":", label="Escalation rate")
    ax1.axvline(cal_tau_h, color=C_CAL, linewidth=0.7, linestyle="--", alpha=0.7)
    ax1.text(cal_tau_h + 0.008, 0.5,
             f"calibrated\n({cal_tau_h:.3f})",
             fontsize=5, color=C_CAL, va="center", fontstyle="italic")
    ax1.set_xlabel(r"$\tau_h$ (block threshold)")
    ax1.set_ylabel("Rate")
    ax1.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=0))
    ax1.set_title(r"(a) Varying $\tau_h$ ($\tau_l$ fixed)", fontsize=7.5)
    ax1.legend(fontsize=5.5, loc="center left", framealpha=0.8)
    ax1.xaxis.grid(True, linewidth=0.2, color="#f3f4f6")
    ax1.yaxis.grid(True, linewidth=0.2, color="#f3f4f6")
    ax1.set_axisbelow(True)

    # Right: tau_low sweep
    ax2.plot(tau_l_range, block_vs_l, color=C_BLOCK, linewidth=1.2,
             label="L2 catch rate (mal.)")
    ax2.plot(tau_l_range, fp_vs_l, color=C_FP, linewidth=1.2,
             label="Not auto-allowed (ben.)")
    ax2.plot(tau_l_range, esc_vs_l, color=C_ESC, linewidth=0.8,
             linestyle=":", label="Escalation rate")
    ax2.axvline(cal_tau_l, color=C_CAL, linewidth=0.7, linestyle="--", alpha=0.7)
    ax2.text(cal_tau_l + 0.008, 0.5,
             f"calibrated\n({cal_tau_l:.3f})",
             fontsize=5, color=C_CAL, va="center", fontstyle="italic")
    ax2.set_xlabel(r"$\tau_l$ (allow threshold)")
    ax2.set_title(r"(b) Varying $\tau_l$ ($\tau_h$ fixed)", fontsize=7.5)
    ax2.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=0))
    ax2.legend(fontsize=5.5, loc="center right", framealpha=0.8)
    ax2.xaxis.grid(True, linewidth=0.2, color="#f3f4f6")
    ax2.yaxis.grid(True, linewidth=0.2, color="#f3f4f6")
    ax2.set_axisbelow(True)

    plt.tight_layout(w_pad=1.5)

    for out_dir in [
        ROOT / "paper-emnlp" / "figures",
        ROOT.parent / "workshops" / "icml" / "images",
        ROOT.parent / "workshops" / "sao" / "images",
        ROOT.parent / "workshops" / "rleval" / "images",
    ]:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "threshold_sensitivity.pdf"
        fig.savefig(out, bbox_inches="tight", dpi=600)
        print(f"Saved: {out}")

    # Save data
    json_out = ROOT / "results" / "threshold_sensitivity.json"
    json_out.write_text(json.dumps({
        "calibrated_tau_h": cal_tau_h,
        "calibrated_tau_l": cal_tau_l,
        "n_test_mal": len(test_mal),
        "n_test_ben": len(test_ben),
    }, indent=2))
    print(f"Saved: {json_out}")


if __name__ == "__main__":
    main()
