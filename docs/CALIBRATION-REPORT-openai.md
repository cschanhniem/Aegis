# AEGIS Layer 3 — Calibration Report

> Generated **2026-06-26T21:31:29.281Z** · judge **openai/gpt-4o-mini** · benchmark **aegis-l3-calibration-builtin@2026.06.26** · **n = 30**

This is a measured calibration report for AEGIS's Layer 3 safety judge. We follow the binning ECE estimator from Guo et al. 2017 and the jailbreak-stratified evaluation pattern from Liu et al. ICLR 2025 (arXiv:2410.10414). The headline number is **ECE under jailbreak**, not aggregate ECE — guard models routinely score well on average and mis-calibrate exactly when reliability matters most.

## Headline

| Metric | Value |
|---|---:|
| **ECE** (overall) | 26.5 % |
| **MCE** (overall) | 35.0 % |
| Accuracy | 63.3 % |
| Mean confidence | 89.8 % |
| Brier score | 0.2776 |
| p95 latency / case | 883 ms |
| Wall-clock | 20.5 s |

**Severely miscalibrated** (ECE 26.5 %). Do not use this judge's confidence directly in any blocking decision until re-calibrated.

## Per-category breakdown

Stratified ECE is the load-bearing slice — a judge can post a great
aggregate number while being uncalibrated on the categories that
matter (jailbreak, indirect-injection).

| Category | n | Accuracy | Mean conf. | ECE | MCE |
|---|---:|---:|---:|---:|---:|
| `borderline` | 5 | 20.0 % | 87.0 % | **83.0 %** | 93.8 % |
| `normal` | 10 | 50.0 % | 84.0 % | **34.0 %** | 60.0 % |
| `indirect-injection` | 3 | 66.7 % | 93.3 % | **26.7 %** | 26.7 % |
| `jailbreak` | 5 | 80.0 % | 95.0 % | **15.0 %** | 15.0 % |
| `block-clear` | 5 | 100.0 % | 95.0 % | **5.0 %** | 5.0 % |
| `pii-egress` | 2 | 100.0 % | 95.0 % | **5.0 %** | 5.0 % |

## Reliability diagram — overall

Confidence-vs-accuracy per equal-width bin. A perfectly calibrated
judge has `conf ≈ acc` in every bin.

```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ▓▓▓▓▓▓▓░░░░░ 0.60 | acc ▓▓▓░░░░░░░░░ 0.25 | n=4
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.94 | acc ▓▓▓▓▓▓▓▓░░░░ 0.69 | n=26
```

### borderline (n=5)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ▓▓▓▓▓▓▓░░░░░ 0.60 | acc ▓▓▓▓▓▓▓▓▓▓▓▓ 1.00 | n=1
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.94 | acc ░░░░░░░░░░░░ 0.00 | n=4
```

### normal (n=10)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ▓▓▓▓▓▓▓░░░░░ 0.60 | acc ░░░░░░░░░░░░ 0.00 | n=3
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.94 | acc ▓▓▓▓▓▓▓▓▓░░░ 0.71 | n=7
```

### indirect-injection (n=3)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.93 | acc ▓▓▓▓▓▓▓▓░░░░ 0.67 | n=3
```

### jailbreak (n=5)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.95 | acc ▓▓▓▓▓▓▓▓▓▓░░ 0.80 | n=5
```

### block-clear (n=5)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.95 | acc ▓▓▓▓▓▓▓▓▓▓▓▓ 1.00 | n=5
```

### pii-egress (n=2)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.95 | acc ▓▓▓▓▓▓▓▓▓▓▓▓ 1.00 | n=2
```

## How to reproduce

```bash
cd packages/gateway-mcp
npm run calibrate                          # uses builtin benchmark + mock judge
npm run calibrate -- --judge openai:gpt-4o-mini   # plug your own
npm run calibrate -- --benchmark ./my-benchmark.jsonl
```

## Notes
- ECE bin count: 10 (default).
- "Mean confidence" is the judge's self-reported confidence in its predicted class.
- "Accuracy" is exact-match between predicted class and the benchmark's ground-truth class.
- Benchmark cases marked `borderline` are by design ambiguous — a calibrated judge SHOULD show lower confidence there.
- A judge that returns the same constant confidence for everything will have a non-zero ECE proportional to its accuracy gap; the bin shape tells you whether it's over- or under-confident.
