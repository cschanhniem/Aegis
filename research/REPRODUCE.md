# Reproducing the AEGIS / EMNLP 2026 results

End-to-end commands. Each step is independent and idempotent.

## 0. Environment

```bash
cd research
python -m venv .venv && source .venv/bin/activate
pip install -e .[llm,guard]
```

## 1. Build the benchmark (WS-1)

```bash
# Fetch all public datasets (git + huggingface hints printed if missing)
python -m benchmark.scripts.download_all

# Materialize OWASP and self-suite (no network)
python -m benchmark.scripts.build_owasp_payloads
python -m benchmark.scripts.extract_aegis_self

# Unify into one JSONL
python -m benchmark.build
python -m benchmark.stats
```

## 2. Run baselines (WS-2)

```bash
# Bring up the production gateway for the AEGIS-rules baseline
( cd ../packages/gateway-mcp && node dist/server.js ) &

# Cheap baselines (no API keys needed)
python -m baselines.run --baseline no_defense
python -m baselines.run --baseline keyword_blacklist
python -m baselines.run --baseline aegis_rules

# LLM judges (require keys)
export ANTHROPIC_API_KEY=sk-...
python -m baselines.run --baseline llm_judge_anthropic --model claude-haiku-4-5-20251001
python -m baselines.run --baseline llm_judge_anthropic --model claude-sonnet-4-6
export OPENAI_API_KEY=sk-...
python -m baselines.run --baseline llm_judge_openai --model gpt-4o-mini
python -m baselines.run --baseline llm_judge_openai --model gpt-4o

# Llama-Guard (requires a GPU; on Delta:
#   srun --account=bfsl-delta-gpu --gres=gpu:a100:1 --time=01:00:00 --pty bash )
python -m baselines.run --baseline llama_guard
```

## 3. Run the cascade method (WS-3)

```bash
# Full cascade (L1 + L2 + L3)
python -m cascade.run_cascade \
    --l1 aegis_rules \
    --l3 llm_judge_anthropic --l3-model claude-haiku-4-5-20251001 \
    --tau-high 0.7 --tau-low 0.4

# Ablation: L1 only
python -m cascade.run_cascade --l1 aegis_rules --no-l2 --no-l3 --tag ablate-L1
# L1 + L2
python -m cascade.run_cascade --l1 aegis_rules --no-l3 --tag ablate-L1L2
# L2 + L3 (no rules — shows recall ceiling without cheap layer)
python -m cascade.run_cascade --no-l1 \
    --l3 llm_judge_anthropic --l3-model claude-haiku-4-5-20251001 \
    --tag ablate-L2L3
```

## 4. Adaptive attack (WS-4)

```bash
# Deterministic obfuscation transforms (9 types)
python -m adaptive.obfuscate \
    --in benchmark/data/aegis-bench.jsonl \
    --out benchmark/data/aegis-bench-obfuscated.jsonl

# Re-run any baseline / cascade on the obfuscated set
python -m baselines.run --baseline aegis_rules \
    --in benchmark/data/aegis-bench-obfuscated.jsonl

# LLM red-team loop against a chosen defender
python -m adaptive.red_team \
    --seeds benchmark/data/aegis-bench.jsonl \
    --defender aegis_rules \
    --attacker-model claude-sonnet-4-6 \
    --rounds 5 \
    --out benchmark/data/adaptive-aegis_rules.jsonl
```

## 5. Granularity + sequence (WS-5)

```bash
PYTHONPATH=. python scripts/slice_by_granularity.py \
    --in benchmark/data/aegis-bench.jsonl \
    --out-dir benchmark/data/slices

# Then run any baseline on slice-coarse.jsonl / slice-fine.jsonl

PYTHONPATH=. python scripts/sequence_eval.py \
    --in benchmark/data/aegis-bench.jsonl
```

## 6. Aggregate results into paper tables/figures (WS-6)

```bash
# (To be added) python -m scripts.aggregate_results --out paper-emnlp/figures/
```

The paper skeleton is in `paper-emnlp/main.tex`; numbers/tables tagged
`\todo{...}` should be filled from the JSON summaries in `results/`.
