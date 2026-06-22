"""Cascade L1/L2/L3 method.

Reframes AEGIS as a cost-aware cascade:
    L1  rules         (microseconds, high precision, low recall on novel)
    L2  behavior+IF   (milliseconds, sequence/feature-level, catches novel)
    L3  LLM judge     (seconds, intent-level, catches ambiguous)

Each layer outputs (decision, confidence). The cascade short-circuits as
soon as a layer is confident enough; otherwise it escalates. Reported in
the paper as the new method, with per-layer ablation as the experiment that
proves the cascade is *necessary* (L1 alone, L1+L2, L1+L2+L3).
"""

from .pipeline import CascadePipeline
from .features import ToolCallFeatures, encode

__all__ = ["CascadePipeline", "ToolCallFeatures", "encode"]
