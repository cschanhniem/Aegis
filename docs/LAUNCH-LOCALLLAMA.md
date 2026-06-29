# r/LocalLLaMA submission pack — AEGIS

Different audience from HN. r/LocalLLaMA is overwhelmingly:

- Self-hosters who already run Ollama / LMStudio / vLLM
- Skeptical of closed APIs (so OpenAI / Anthropic positioning gets
  side-eye)
- Deeply technical, low patience for marketing
- Comments are often more interesting than the post

The playbook below is calibrated to this audience.

---

## When to post

r/LocalLLaMA volume is steady across the week but spikes:

- **Best:** Wednesday – Friday, **9:00 – 11:00 Pacific** (US morning).
- **Second-best:** Tuesday 14:00 Pacific.
- **Avoid:** Monday morning (drowns in weekend posts), late Friday
  (heading-into-weekend tail off).

Aim for ~36 hours after your Show HN post. The audience overlap is
~15 %; you don't want the same content within the same window.

---

## Title — A/B options

r/LocalLLaMA titles can be longer; signal matters more than catch.

1. **AEGIS — open-source agent firewall, MIT, measured calibration on gpt-4o-mini + claude-haiku-4-5** ← recommended
2. **I measured Expected Calibration Error on gpt-4o-mini and Anthropic claude-haiku-4-5 — both severely miscalibrated under jailbreak. Methodology + raw data.**
3. **Show: AEGIS — self-hosted, parameter-level taint propagation against indirect prompt injection (MIT)**

Option 1 wins because it leads with **open-source + MIT** (massive
signal to this audience), names the **product class** clearly
(firewall, not "guardrails"), and ends with the **measurement hook**
that drives comments.

Option 2 is more academic — better if you want a focused calibration
discussion, less useful for product launch.

---

## Post body

Copy this into the body field:

```
Built AEGIS — an open-source runtime safety layer for AI agents — and
ran an Expected Calibration Error measurement on the two most-deployed
guard models. Sharing the methodology + raw numbers because nobody
else publishes them.

**Setup:**

- 30-case benchmark of agent tool-call scenarios split across 6
  categories (normal / block-clear / pii-egress / jailbreak /
  indirect-injection / borderline)
- Each case has a ground-truth label (allow / block / escalate) and
  the judge must return both a decision + a confidence score in [0,1]
- Standard Guo et al. 2017 binning ECE estimator, 10 bins, jailbreak-
  stratified (the headline measurement from Liu et al. ICLR 2025)
- Same system prompt for both models, temperature 0, structured-
  output mode where available

**Results:**

|                  | OpenAI gpt-4o-mini | Anthropic claude-haiku-4-5 |
|------------------|-------------------:|---------------------------:|
| Overall ECE      | 26.5%              | 29.2%                      |
| Accuracy         | 63.3%              | 63.3%                      |
| Mean confidence  | 89.8%              | 92.5%                      |
| Brier score      | 0.205              | 0.221                      |

Both severely miscalibrated. The interesting part is the per-category
breakdown — both models go from ~7-11% ECE on easy cases to **60-89%
ECE** on borderline / indirect-injection cases. They are confidently
wrong exactly when reliability matters.

**Architecture (3 layers):**

1. Static policy in a grammar-constrained DSL — fast, deterministic.
2. Sequence-aware behavioural anomaly per-agent baseline — classical
   methods (n-gram, Mahalanobis, Isolation Forest), upgrading to SRAE
   per Trajectory Guard (AAAI 2026).
3. LLM judge — last resort, with the ECE measurement above.

Plus parameter-level taint propagation (FIDES / IPIGuard pattern),
RFC 6962 Merkle audit log with witness co-signature.

**How to use:**

```bash
curl -fsSL aegistraces.com/install | sh
aegis start --provider ollama --model qwen3:7b
```

Engine is MIT and runs entirely on your hardware. Optional cloud
license for Pro features (team dashboard, alert routing). Open-core
model — GitLab / Sentry / Tailscale pattern.

Tested against Ollama, LMStudio, vLLM, llama.cpp local endpoints in
addition to the OpenAI / Anthropic / Bedrock cloud APIs.

**Links:**

- Calibration methodology + raw data:
  https://aegistraces.com/blog/llm-judge-calibration
- Repo (MIT): https://github.com/Justin0504/Aegis
- 71-page handbook PDF (all 12 articles compiled):
  https://aegistraces.com/handbook.pdf
- Reproduce: `npm run calibrate -- --judge ollama:qwen3:7b`

**Want feedback on:**

1. Should we replace `claude-haiku-4-5` with a local SLM judge
   (e.g. GLIDER, 3.8B distilled)? Calibration data on local models is
   approximately zero in the published literature.
2. Best way to benchmark taint propagation? AgentDojo is the
   industry standard but it's not designed for local-model deployment.
3. Anyone done end-to-end self-hosted local benchmarks against
   indirect prompt injection in production? I want to compare.
```

**Why this body works for LocalLLaMA:**
- Opens with the **measurement** (the audience cares about real
  numbers more than product features).
- **Data table** at the top — Reddit renders Markdown tables; HN
  doesn't. Different formatting choice.
- **Local-first framing** — `qwen3:7b`, Ollama, vLLM mentions.
  Cloud APIs are mentioned but not centered.
- **MIT** in the title and twice in the body — this audience
  filters on license aggressively.
- **3 questions** for the comment thread, all technical and
  inviting expertise.
- **Reproducibility** — give them the command. They will run it.

---

## Anti-patterns specific to r/LocalLLaMA

1. **Don't say "AI safety"** as a category — many in the audience
   are skeptical of the "safety" framing (associated with
   closed-source / corporate gatekeeping). Use "agent safety" or
   "agent firewall" — more concrete.

2. **Don't link to a SaaS landing page first.** Link to the GitHub
   repo or the calibration methodology page. The marketing site link
   should be ~4th.

3. **Don't compare yourself to OpenAI's moderation API.** This
   audience uses local models specifically to escape OpenAI; framing
   AEGIS as an OpenAI-compatible thing is anti-signal.

4. **Don't post benchmarks against cloud-only competitors only.**
   Include local model results.

5. **Don't censor questions about training data.** The audience will
   ask "what data did you use to train the detector?" If the answer
   is "we don't train detectors, we use deterministic rules + per-
   tenant baselines," say that clearly. It's actually a strong
   answer.

---

## What the comments will probably look like

Common questions to prepare for:

- **"Does this work with Ollama?"** Yes — `--provider ollama --model
  qwen3:7b`.

- **"What about vLLM?"** Yes — OpenAI-compatible endpoint, just point
  the URL.

- **"How much overhead per tool call?"** ~14ms p50, 47ms p99 measured.
  Mostly the policy evaluator; the gateway itself is sub-millisecond.

- **"Does it phone home?"** Community edition: no. Pro edition: only
  license heartbeat + (optional) anonymous usage metrics. Source-
  inspectable.

- **"What's the catch with the free tier?"** Honest answer: it's the
  same engine as Pro. Pro adds multi-org dashboard, policy sync, and
  email support. The protection is identical.

- **"Why MIT and not AGPL?"** Considered AGPL for a week. Decided
  against because (1) we want unmodified deployment in restrictive
  environments where AGPL is rejected by procurement, (2) the
  protection is in the cryptographic audit and the brand, not in
  license enforcement.

- **"Have you tested against [obscure injection technique]?"** We
  have a red-team corpus of ~120 scenarios. List of patterns covered
  is in the repo. PRs welcome for additional scenarios.

- **"Why is the dashboard a separate tier?"** Because operating a
  multi-org SaaS dashboard costs money. The engine — which is what
  actually protects you — is and stays free.

---

## After-post engagement

- **Stay in the thread for 6+ hours.** r/LocalLLaMA's discussion
  half-life is longer than HN's. Comments come in waves over a full
  day.

- **Post code examples in replies.** When someone asks "how do I
  use this with vLLM?", give them the exact 3-line snippet.

- **Link back to the methodology blog post liberally.** Reddit
  doesn't have HN's "no self-promotion" reflex; the audience expects
  primary sources.

- **Don't argue about safety theater.** If someone says "this is
  cargo-cult security," ask them which specific layer they think is
  ineffective. Engage on the substance. Don't defend the framing.

---

## Expected outcome

r/LocalLLaMA has ~600k subscribers as of mid-2026. Median post hits
~200 upvotes. A strong launch with real data + open-source license
should land:

- **Best case:** Top of subreddit for 12+ hours, 500-1.5k upvotes,
  ~3-5k GitHub stars from this single channel
- **Median case:** ~300 upvotes, ~50-200 GitHub stars
- **Floor case:** 80 upvotes, ~10-20 stars. Still worth doing.

Subreddit half-life is ~24 hours; expect comment volume to drop sharply
after that. Total time investment: ~5 hours active over 2 days.
