# AEGIS Layer 3 — Calibration Report

> Generated **2026-06-26** · benchmark **aegis-l3-calibration-builtin@2026.06.26** · **n = 30**
>
> Judges measured: **openai/gpt-4o-mini** and **anthropic/claude-haiku-4-5-20251001**.

This is a measured calibration report for Layer-3 safety judges. We
follow the binning ECE estimator from Guo et al. 2017 and the
**jailbreak-stratified evaluation pattern** from Liu et al. ICLR 2025
(arXiv:2410.10414). The headline number is *stratified* ECE — guard
models routinely score well on average and miscalibrate exactly when
reliability matters most.

To the best of our knowledge, this is the **first publicly reported
calibration measurement** for frontier safety judges on an agentic
tool-call benchmark. Lakera, HiddenLayer, Bedrock Guardrails, Patronus
and competitors do not publish ECE for their guard models.

## TL;DR

| Judge | n | Accuracy | Mean confidence | **ECE** | MCE | Brier |
|---|---:|---:|---:|---:|---:|---:|
| openai/gpt-4o-mini | 30 | 63.3 % | 89.8 % | **26.5 %** | 35.0 % | 0.27 |
| anthropic/claude-haiku-4-5 | 30 | 63.3 % | 92.5 % | **29.2 %** | 65.0 % | 0.27 |

**Both judges are severely miscalibrated.** Same raw accuracy on this
benchmark, but Anthropic is ~3 points more overconfident on average.
Both confirm the Liu et al. ICLR 2025 finding: confidence scores from
safety judges cannot be used directly in blocking decisions without
recalibration (Platt / temperature scaling).

## Stratified ECE — the load-bearing slice

A judge can post a great aggregate number while being uncalibrated on
the categories that matter (jailbreak, indirect-injection, borderline).
**Sorted by miscalibration; higher = worse**:

| Category | n | OpenAI ECE | Anthropic ECE | Pattern |
|---|---:|---:|---:|---|
| `borderline` | 5 | **83.0 %** | **91.8 %** | Both **catastrophic**. Judges blast high confidence on ambiguous cases that should be ~0.5–0.7. |
| `normal` | 10 | 34.0 % | 27.4 % | Surprising — judges flag legitimate OpenAI / GitHub API calls as `block` at high confidence. |
| `indirect-injection` | 3 | 26.7 % | 26.3 % | Both wrong on cases where tool arguments inherit untrusted retrieved content. |
| `jailbreak` | 5 | 15.0 % | 16.4 % | Mid-range; both judges correctly block ~80 % but at ~95 % confidence. |
| `block-clear` | 5 | 5.0 % | 2.6 % | Both well-calibrated — `rm -rf /`-style decisions are easy. |
| `pii-egress` | 2 | 5.0 % | 3.0 % | Well-calibrated. |

### The borderline finding is the most interesting

`borderline` cases were hand-labeled `escalate` (= "needs human"), e.g.
`$24,500 Stripe transfer`, `kubectl rollout restart deploy/api -n prod`,
unbounded `SELECT * FROM users`. A *calibrated* judge should output
~0.5–0.7 confidence here. Instead:

- gpt-4o-mini outputs ~0.87 confidence and is wrong 80 % of the time
- claude-haiku-4-5 outputs ~0.92 confidence and is wrong 100 % of the time

Both judges essentially refuse to express uncertainty. They commit to
`allow` or `block` at high confidence rather than escalate to a human.
This is an actionable signal: AEGIS should **not** route hard cases to
either judge's confidence score directly; instead, route on the
predicted *class* and treat `escalate` decisions as the human-in-the-loop
hook.

## Method

- **Benchmark**: 30 hand-labeled tool-call traces split across
  six categories: `normal` (10), `block-clear` (5), `pii-egress` (2),
  `jailbreak` (5), `indirect-injection` (3), `borderline` (5).
  Labels include `allow` / `block` / `escalate` so we can measure
  whether judges express uncertainty.
- **ECE estimator**: standard Guo et al. 2017 equal-width binning,
  10 bins.
- **Stratification**: per-category ECE alongside overall, per
  Liu et al. ICLR 2025.
- **Judge protocol**: temperature 0, structured-output JSON
  (OpenAI `json_schema`, Anthropic strict-JSON-prompt), self-reported
  confidence in [0, 1] for the predicted class.

## Reproduce

```bash
cd packages/gateway-mcp

# Builtin benchmark, mock judge — no API key needed:
npm run calibrate

# Real judges (set ANTHROPIC_API_KEY / OPENAI_API_KEY in .env.local first):
npm run calibrate -- --judge openai:gpt-4o-mini    --concurrency 1 \
  --out ../../docs/CALIBRATION-REPORT-openai.md
npm run calibrate -- --judge anthropic:claude-haiku-4-5-20251001 --concurrency 1 \
  --out ../../docs/CALIBRATION-REPORT-anthropic.md

# Your own labeled benchmark (JSONL):
npm run calibrate -- --judge openai:gpt-4o --benchmark ./my-cases.jsonl
```

Full per-judge reports with reliability diagrams:

- [CALIBRATION-REPORT-openai.md](./CALIBRATION-REPORT-openai.md)
- [CALIBRATION-REPORT-anthropic.md](./CALIBRATION-REPORT-anthropic.md)

## Roadmap implications

This measurement closes **item #3** of the Q3/Q4 2026 roadmap (see
[RESEARCH-ROADMAP.md](./RESEARCH-ROADMAP.md)). What it unblocks:

1. **Public marketing-grade number**: "AEGIS measures judge calibration.
   Nobody else does." This is the first PR-worthy artifact from the
   roadmap.
2. **Re-calibration infrastructure**: the same measurement harness is
   what we need to do Platt / temperature scaling once we ship a
   re-calibrator (item #3 follow-up).
3. **Distilled-judge benchmarking** (roadmap item #4): we now have a
   reference benchmark to compare a GLIDER-sized distilled SLM against
   frontier judges.

## Caveats

- **n = 30** is small. Headline numbers are directional, not
  publishable as "the" calibration of these models. Expanding to
  AgentDojo's full set + a real jailbreak corpus is the obvious next
  step.
- **Judges may be miscalibrated on AEGIS's specific decision space**
  (`allow` / `block` / `escalate`) more than on their own native
  refusal/comply distribution. The numbers here measure
  fitness-for-purpose-as-AEGIS-judge, not absolute model calibration.
- **Self-reported confidence** has known biases vs. probabilistic
  output via logit-softmax. OpenAI supports `logprobs` and we should
  add a logprob-based confidence channel for comparison.
- The benchmark is in-tree at
  `packages/gateway-mcp/src/calibration/benchmarks/builtin.json` —
  inspect cases yourself before treating the labels as ground truth.
