"""WS-4: adaptive attacker / evasion analysis.

Two complementary tracks:

  obfuscate.py   — deterministic, fast; hex/Unicode/comment/case rewrites of
                   *existing* payloads. Cheap; gives a robustness curve per
                   transformation type.
  red_team.py    — LLM-driven; iteratively rewrites payloads given a hard
                   "did you bypass AEGIS?" oracle. Slow; gives the
                   asymptotic bypass rate per defender layer.

Both write augmented benchmark JSONL files that are evaluated by the
existing baselines/cascade runners — no extra harness needed.
"""
