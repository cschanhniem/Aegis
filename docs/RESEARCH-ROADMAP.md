# AEGIS 2026 Q3/Q4 — Research-Informed Roadmap

Generated 2026-06-26 by deep-research (115 agents, 32 sources, 25 claims
verified with 3-vote adversarial). Findings cite 2024–2026 papers and
mid-2026 commercial products. Treat the roadmap below as engineering
direction — not marketing copy.

## TL;DR — honest assessment

| Layer | AEGIS today | Field SOTA mid-2026 | Verdict |
|---|---|---|---|
| **L1 — Static** | Tool-level allow/deny + AJV bundles + DSL | Parameter-level taint propagation (FIDES, NeuroTaint, IPIGuard) | **Behind.** Closing this is the single highest-ROI change. |
| **L2 — Sequence** | n-gram + Mahalanobis + Isolation Forest | Sequence-aware learned detectors (SRAE, F1 0.88–0.94 @ 32ms) | **Behind.** Classical methods cap at F1 ≤ 0.69 in published benchmarks. |
| **L3 — Judge** | LLM judge + counterfactual explainer | Calibrated guard models; distilled 3.8B judge (GLIDER) beats GPT-4o | **Behind on calibration.** No competitor publishes ECE — opportunity. |
| **Memory & cross-agent** | Implicit in trace | Named layer (HiddenLayer 2026) | **Parity-by-renaming.** AEGIS has the data, isn't packaging it. |
| **NL→Policy** | Grammar-constrained DSL compilation | Policy-as-prompt (Pure Storage POLICY-TREE-GEN) | **Ahead structurally** — but missing typed extraction + provenance audit. |
| **Pre-deploy scan** | tree-sitter AST, 5 frameworks | Mostly absent from competitors | **Ahead.** Real moat. |
| **Audit log** | Merkle + witness cosig | Mostly absent | **Ahead.** Real moat. |

**Honest summary**: AEGIS is *structurally* well-positioned (good layer
decomposition, real cryptographic audit, real static scanner), but
*algorithmically behind* on every detection layer — the field has moved
to taint-tracking + learned sequence models + calibrated judges, and we
haven't.

## The 8-Point Roadmap

Each item: **what to ship · why (cited) · effort · moat-value**.

### 1. Parameter-level taint propagation — Layer 1

**Ship** — every tool argument carries a provenance label (`user`,
`retrieval`, `web`, `file`, `memory`). High-risk sinks (`send_email`,
`write_file`, `exec`) gate on taint policy, not just tool allow-list.
A calendar tool is safe in general but unsafe when its `recipient`
field inherits content from a webpage fetched earlier.

**Cite**: FIDES (arXiv 2505.23643, Microsoft) · Agent-Sentry
(2603.22868) · NeuroTaint (2604.23374) · IPIGuard (EMNLP 2025 oral,
2508.15310 — 0.69 % ASR / 58.77 % UA) · survey 2606.04990. The 2026
field has decisively shifted from text-classifier IPI detection to
parameter-level provenance.

**Effort**: medium (~2–4 weeks). Touches gateway interceptor,
trace schema, policy DSL. **Moat**: high — closes the largest published
gap vs. AEGIS today and is the dominant academic answer to IPI.

### 2. Sequence-aware learned detector — Layer 2

**Ship** — replace `IsolationForest` / `Mahalanobis` with a Siamese
Recurrent Autoencoder (or transformer encoder) over tool-call traces,
trained per-agent on baseline trajectories. Keep classical detectors
as a cheap warmup pre-filter.

**Cite**: Trajectory Guard (arXiv 2601.00516, AAAI TrustAgent 2026) —
F1 0.88–0.94 vs. ≤ 0.69 for embedding-only methods on RAS-Eval and
Who&When, at 32 ms latency. *Caveat*: single-author preprint,
self-reported, no independent replication. Reproduce on AEGIS's own
trace distribution before shipping as default.

**Effort**: medium (~3–5 weeks). New ML pipeline + per-agent training
loop + serving infra. **Moat**: high — sub-50 ms cascade pre-filter
matches Lakera's published SLA.

### 3. Layer 3 calibration report

**Ship** — publish ECE, reliability diagrams, and **jailbreak-stratified**
calibration on a public benchmark (AgentDojo + jailbreak suite). Treat
calibration as a first-class product surface: "our judge is X % ECE,
Y % under jailbreak."

**Cite**: Liu et al. *On Calibration of LLM-based Guard Models for
Reliable Content Moderation* (ICLR 2025, arXiv 2410.10414). Empirical
evaluation of 9 guard models on 12 benchmarks finds:
(a) overconfident predictions, (b) significant miscalibration under
jailbreak attacks, (c) limited robustness across response models.
**Nobody else publishes this** — opportunity to set the bar.

**Effort**: low (~1–2 weeks). Existing judge + new measurement harness.
**Moat**: high — first-mover on a research-validated trust signal.

### 4. Distilled judge SLM

**Ship** — distill AEGIS L3 judge into a 3–8 B SLM with explainable
rationale output. Benchmark vs. GLIDER on FLASK + Summeval; publish
the human-agreement %.

**Cite**: GLIDER (arXiv 2412.14140, Patronus, Dec 2024) — Phi-3.5-mini
3.8 B judge, beats GPT-4o on FLASK Pearson, ~91 % human agreement on
Summeval. *Caveats*: 91 % is on one curated dataset; FLASK win is
Pearson-specific.

**Effort**: medium (~3–4 weeks for distillation + eval). **Moat**:
medium — cuts judge cost 10–20 × and enables on-prem / airgap deploys
that no API-only competitor can offer.

### 5. Memory & cross-agent contamination layer

**Ship** — package what AEGIS already sees in traces as a *named*
detection layer: "unsafe memory recall," "cross-agent contamination,"
"sensitive data surfacing before becoming an instruction." Show it in
the cockpit as a distinct tab with its own metrics.

**Cite**: HiddenLayer agentic product (March 2026) markets this as a
distinct capability. AEGIS has the trace infra to do this **cheaply**
but isn't currently packaging it.

**Effort**: low (~1 week — mostly UI + a few new detector rules over
existing trace data). **Moat**: medium — parity with the most-visible
2026 entrant; pure positioning win.

### 6. Typed extraction in NL→DSL

**Ship** — pre-pass on natural-language policy input that extracts
verbatim statements into a typed 4-category tree (`VALINP`, `INVALINP`,
`VALOUT`, `INVALOUT`) and runs a judge-LLM verbatim-traceability check
before compilation to DSL.

**Cite**: Kholkar & Ahuja (Pure Storage, arXiv 2509.23994,
POLICY-TREE-GEN) — verified two-pass parsing with provenance-linked
audit. Their mechanism is policy-as-prompt; AEGIS keeps the compiled
DSL edge while gaining auditable source-linked provenance.

**Effort**: medium (~2 weeks). **Moat**: medium — preserves AEGIS's
DSL differentiation while closing an auditability gap Pure Storage
has already marketed.

### 7. Activation-probe layer (research bet)

**Ship** — for self-hosted / open-weight deployments (Llama / Qwen /
DeepSeek), add linear probes on internal activations to detect
multi-agent collusion. Scope to OSS models only — closed-weight
(Anthropic / OpenAI / Google) can't access activations.

**Cite**: Rose et al. (Oxford+CISPA, arXiv 2604.01151) — linear probes
on activations show colluding-agent activations spike on encoded
partner messages. Token-localized signal **genuinely invisible to all
three current AEGIS layers**. *Caveats*: the strongest claim (1.00
in-distribution AUROC) was refuted in our adversarial verification;
0.73–0.93 zero-shot transfer claim survived. Probes have known failure
modes (adversarial suffix evasion, RL-finetune-to-hide).

**Effort**: high (~6–8 weeks, research-grade). **Moat**: high — no
competitor has this; bounded addressable market (OSS-only).

### 8. Public latency + coverage matrix (table-stakes)

**Ship** — publish AEGIS's measured inline-path latency (target
< 50 ms p95) and an attack-taxonomy coverage matrix vs. Lakera /
HiddenLayer / Bedrock.

**Cite**: Lakera Guard advertises "sub-50ms runtime latency" (set the
SLA bar). Bedrock publishes 31 PII entity types. Buyers compare on
these axes.

**Effort**: low (~3 days — measurement + a marketing page).
**Moat**: low — but you can't win competitive RFPs without these
numbers visible.

## What got refuted (don't cite these)

Five claims were killed during adversarial verification — do **not**
include them in any pitch deck or roadmap doc:

1. Activation probes hitting **1.00 AUROC in-distribution** for collusion
   detection. Only the weaker 0.73–0.93 zero-shot transfer survived.
2. IPIGuard's mechanism being explicit "trust anchor identification."
   The actual mechanism is structural tool-dependency-graph analysis.
3. "Text-highlight explanations measurably improve judge performance"
   — Patronus's marketing claim, not measurably supported.
4. Bedrock's `InvokeGuardrailChecks` API exposing
   `BeforeInvocationEvent` / `AfterToolCallEvent` etc. — this was a
   blog inference, not in AWS documentation.
5. "Effective IPI defense requires explicit trust-anchor identification."
   The actual answer is taint propagation, not trust labels.

## Open questions (need internal measurement)

1. **What is AEGIS Layer 2's measured F1 on RAS-Eval / Who&When today?**
   Without this number we can't quantify the SRAE upgrade payoff.
2. **What calibration benchmark to commit to publicly** — AgentDojo +
   jailbreak suite, HarmBench, AIR-Bench, or AEGIS-curated? Affects
   marketing-vs-rigor tradeoff.
3. **Taint propagation utility cost** — CaMeL-style information-flow
   systems report ~7-point AgentDojo utility drop. Need to measure
   AEGIS's drop before shipping default-on.
4. **Activation probing legal/operational viability** — for closed-weight
   AEGIS customers (Anthropic / OpenAI / Google), only OSS deployments
   can use this. Sizes the addressable market.

## Sequencing recommendation

Do **item 3 first** (calibration report, low effort, high moat) — it
generates a credible public number we can market, and the measurement
harness it requires becomes infra for items 2 and 4.

Then **item 5** (memory layer rebadging, 1 week, medium moat) for an
immediate competitive parity win.

Then **item 1** (parameter taint, 2–4 weeks, biggest gap) followed by
**item 2** (SRAE detector).

Hold **item 7** (activation probes) until you have a self-hosted /
OSS-model design partner.

## Sources

Selected highest-citation:

- **2606.04990** — From Agent Traces to Trust (survey, Jun 2026)
- **2505.23643** — FIDES (Microsoft, information-flow agent control)
- **2603.22868** — Agent-Sentry (taint at ingestion)
- **2604.23374** — NeuroTaint
- **2508.15310** — IPIGuard (EMNLP 2025 oral)
- **2601.00516** — Trajectory Guard (SRAE, AAAI TrustAgent 2026)
- **2410.10414** — Liu et al., guard-model calibration (ICLR 2025)
- **2412.14140** — GLIDER (Patronus, 3.8 B SLM judge)
- **2509.23994** — POLICY-TREE-GEN (Pure Storage, NL→policy)
- **2604.01151** — Multi-agent collusion via activations (Oxford+CISPA)

Commercial:
- lakera.ai/lakera-guard
- hiddenlayer.com/solutions/agentic-mcp-security
- aws.amazon.com — Bedrock Guardrails docs
