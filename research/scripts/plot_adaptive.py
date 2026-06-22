"""Plot adaptive red-team bypass curves from existing results.

For each defender, plots cumulative bypass rate over adversarial rounds.
Data: adaptive/results/adaptive-{defender}-53seeds.jsonl

Style: ICML/NeurIPS best-paper quality.
"""

from __future__ import annotations

import json
from collections import defaultdict
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


def _parse_adaptive(path: Path, n_seeds: int, n_rounds: int = 5):
    """Parse adaptive JSONL. Return bypass_round per seed (-1 if never).

    Logic from red_team.py: each seed generates records for rounds 0..k
    where k is either the bypass round (defender returned ALLOW) or
    n_rounds-1 (all blocked). The LAST record for a seed tells us if
    it was eventually bypassed: if the defender allowed it at round k,
    only rounds 0..k exist.
    """
    records = [json.loads(l) for l in path.open()]

    # Group by seed
    by_seed: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        seed = r["meta"]["original_id"]
        by_seed[seed].append(r)

    # For seeds not in the file at all, they were never tested
    # (shouldn't happen with 53 seeds and 53-seed runs)

    # Determine bypass round for each seed.
    # The red_team.py loop: writes ALL records (blocked and bypassed).
    # If a seed was bypassed at round k, only rounds 0..k are written.
    # If never bypassed, rounds 0..n_rounds-1 are written.
    # So: bypass_round = max round in records if it's < n_rounds-1.
    # But actually, we need to check the defender decision.
    # Since we don't have the decision in the records, use the round count:
    # - If max_round < n_rounds-1, the seed was bypassed at max_round
    # - If max_round == n_rounds-1, never bypassed (all rounds exhausted)

    bypass = {}
    for seed, recs in by_seed.items():
        max_round = max(r["meta"]["adv_round"] for r in recs)
        if max_round < n_rounds - 1:
            bypass[seed] = max_round
        else:
            bypass[seed] = -1  # never bypassed within budget

    return bypass


def main():
    results_dir = ROOT / "adaptive" / "results"
    N_SEEDS = 53
    N_ROUNDS = 5

    configs = [
        ("adaptive-keyword-53seeds.jsonl", "Keyword Blacklist", "#6b7280", "s"),
        ("adaptive-rules-53seeds.jsonl", "AEGIS Rules (L1)", "#dc2626", "D"),
        ("adaptive-llm_judge-53seeds.jsonl", "LLM Judge (Haiku 4.5)", "#3730a3", "o"),
    ]

    fig, ax = plt.subplots(figsize=(3.4, 2.4))

    for fname, label, color, marker in configs:
        path = results_dir / fname
        if not path.exists():
            print(f"Skipping {fname} — not found")
            continue

        bypass = _parse_adaptive(path, N_SEEDS, N_ROUNDS)
        n_tested = len(bypass)

        # Cumulative bypass rate at each round
        rounds = list(range(N_ROUNDS))
        cum_bypass = []
        for r in rounds:
            n_bypassed_by_r = sum(1 for v in bypass.values() if 0 <= v <= r)
            cum_bypass.append(n_bypassed_by_r / n_tested)

        # Also add round -1 (before any rewriting) = 0% bypass
        plot_rounds = [-0.3] + rounds
        plot_rates = [0.0] + cum_bypass

        ax.plot(plot_rounds, plot_rates, color=color, linewidth=1.2,
                marker=marker, markersize=4, markeredgecolor="white",
                markeredgewidth=0.3, label=label, zorder=3)

        # Annotate final bypass rate
        final = cum_bypass[-1]
        ax.text(N_ROUNDS - 1 + 0.15, final,
                f"{final:.0%}", fontsize=5.5, color=color, va="center")

    ax.set_xlabel("Adversarial Round")
    ax.set_ylabel("Cumulative Bypass Rate")
    ax.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=0))
    ax.set_xlim(-0.5, N_ROUNDS - 0.3)
    ax.set_ylim(-0.02, 1.05)
    ax.set_xticks(range(N_ROUNDS))
    ax.set_xticklabels([f"R{i}" for i in range(N_ROUNDS)])

    ax.xaxis.grid(True, linewidth=0.2, color="#f3f4f6")
    ax.yaxis.grid(True, linewidth=0.2, color="#f3f4f6")
    ax.set_axisbelow(True)

    ax.legend(fontsize=5.5, loc="upper left", framealpha=0.9)

    plt.tight_layout()

    for out_dir in [
        ROOT / "paper-emnlp" / "figures",
        ROOT.parent / "workshops" / "icml" / "images",
        ROOT.parent / "workshops" / "sao" / "images",
        ROOT.parent / "workshops" / "rleval" / "images",
    ]:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "adaptive_redteam.pdf"
        fig.savefig(out, bbox_inches="tight", dpi=600)
        print(f"Saved: {out}")


if __name__ == "__main__":
    main()
