# AEGIS Research Workspace

EMNLP 2026 research artifacts for AEGIS (pre-execution agent firewall).

## Layout

```
research/
├── benchmark/          # WS-1: unified tool-call benchmark
│   ├── schema.py       #   canonical record schema
│   ├── loaders/        #   per-source loaders -> canonical records
│   ├── data/           #   raw downloads (gitignored)
│   └── build.py        #   unify -> data/aegis-bench.jsonl
├── baselines/          # WS-2: baseline runners
├── cascade/            # WS-3: L1/L2/L3 cascade method
├── adaptive/           # WS-4: red-team & evasion
├── scripts/            # one-shot helpers (download, etc.)
├── results/            # per-experiment outputs (gitignored except summaries)
└── paper-emnlp/        # WS-6: rewritten manuscript
```

## Canonical record schema

Every benchmark item is normalized to one shape so that all baselines / methods
consume the same input. See `benchmark/schema.py`.

## Reproducing the benchmark

```bash
cd research
python -m benchmark.scripts.download_all   # fetches public datasets
python -m benchmark.build                  # writes data/aegis-bench.jsonl
python -m benchmark.stats                  # prints per-source / per-label stats
```

## Threat-model partitions

The benchmark is partitioned along three axes that we report separately:
- **Distribution shift**: in-distribution (self-curated) / near-OOD / far-OOD
- **Granularity**: coarse-grained tool / fine-grained tool
- **Step locality**: single tool-call / multi-step session
