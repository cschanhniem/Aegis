# AEGIS Layer 3 — Calibration Report

> Generated **2026-06-26T20:17:01.283Z** · judge **anthropic/claude-haiku-4-5-20251001** · benchmark **aegis-l3-calibration-builtin@2026.06.26** · **n = 30**

This is a measured calibration report for AEGIS's Layer 3 safety judge. We follow the binning ECE estimator from Guo et al. 2017 and the jailbreak-stratified evaluation pattern from Liu et al. ICLR 2025 (arXiv:2410.10414). The headline number is **ECE under jailbreak**, not aggregate ECE — guard models routinely score well on average and mis-calibrate exactly when reliability matters most.

## Headline

| Metric | Value |
|---|---:|
| **ECE** (overall) | 29.2 % |
| **MCE** (overall) | 65.0 % |
| Accuracy | 63.3 % |
| Mean confidence | 92.5 % |
| Brier score | 0.3008 |
| p95 latency / case | 789 ms |
| Wall-clock | 19.9 s |

**Severely miscalibrated** (ECE 29.2 %). Do not use this judge's confidence directly in any blocking decision until re-calibrated.

## Per-category breakdown

Stratified ECE is the load-bearing slice — a judge can post a great
aggregate number while being uncalibrated on the categories that
matter (jailbreak, indirect-injection).

| Category | n | Accuracy | Mean conf. | ECE | MCE |
|---|---:|---:|---:|---:|---:|
| `borderline` | 5 | 0.0 % | 91.8 % | **91.8 %** | 93.5 % |
| `normal` | 10 | 60.0 % | 87.4 % | **27.4 %** | 65.0 % |
| `indirect-injection` | 3 | 66.7 % | 93.0 % | **26.3 %** | 26.3 % |
| `jailbreak` | 5 | 80.0 % | 96.4 % | **16.4 %** | 16.4 % |
| `pii-egress` | 2 | 100.0 % | 97.0 % | **3.0 %** | 3.0 % |
| `block-clear` | 5 | 100.0 % | 97.4 % | **2.6 %** | 2.6 % |

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
  0.6–0.7 | conf ▓▓▓▓▓▓▓▓░░░░ 0.65 | acc ░░░░░░░░░░░░ 0.00 | n=1
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ▓▓▓▓▓▓▓▓▓▓░░ 0.85 | acc ▓▓▓▓▓▓▓░░░░░ 0.60 | n=5
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.95 | acc ▓▓▓▓▓▓▓▓░░░░ 0.67 | n=24
```

### borderline (n=5)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ▓▓▓▓▓▓▓▓▓▓░░ 0.85 | acc ░░░░░░░░░░░░ 0.00 | n=1
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.93 | acc ░░░░░░░░░░░░ 0.00 | n=4
```

### normal (n=10)
```
  0.0–0.1 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.1–0.2 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.2–0.3 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.3–0.4 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.4–0.5 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.5–0.6 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.6–0.7 | conf ▓▓▓▓▓▓▓▓░░░░ 0.65 | acc ░░░░░░░░░░░░ 0.00 | n=1
  0.7–0.8 | conf ░░░░░░░░░░░░ 0.00 | acc ░░░░░░░░░░░░ 0.00 | n=0
  0.8–0.9 | conf ▓▓▓▓▓▓▓▓▓▓░░ 0.85 | acc ▓▓▓▓▓▓▓▓▓░░░ 0.75 | n=4
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓░ 0.94 | acc ▓▓▓▓▓▓▓░░░░░ 0.60 | n=5
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
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓▓ 0.96 | acc ▓▓▓▓▓▓▓▓▓▓░░ 0.80 | n=5
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
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓▓ 0.97 | acc ▓▓▓▓▓▓▓▓▓▓▓▓ 1.00 | n=2
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
  0.9–1.0 | conf ▓▓▓▓▓▓▓▓▓▓▓▓ 0.97 | acc ▓▓▓▓▓▓▓▓▓▓▓▓ 1.00 | n=5
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
