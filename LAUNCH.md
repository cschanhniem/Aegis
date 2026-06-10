# AEGIS Launch Drafts

Three formats — Twitter thread, Hacker News "Show HN", LinkedIn post.
Pick what you'll use, swap the link to your actual URL once the
domain is bound, post.

---

## 1) Twitter thread (8 tweets)

> 1/  After 6 months building AEGIS, the runtime safety layer for AI
> agents is open-source and live.
>
> Stop hallucinated tool calls before they hit production. Zero code
> change. MIT licensed.
>
> 👉 https://aegis-marketing.aojieyuan04.workers.dev
> ⭐ github.com/Justin0504/Aegis

> 2/  Every tool your agent calls — classified, scored by a 3-layer
> cascade (rules → ML → LLM-judge), matched against per-tenant policy.
> Before execution.
>
> One env var swap, no SDK rewrite, every framework supported:
>
>   OPENAI_BASE_URL=https://gateway.aegis.dev/openai/v1
>   AEGIS_API_KEY=...

> 3/  What it does that the other guardrail products don't:
>
> ✅ Cryptographic audit (RFC 6962 Merkle + Sigstore witness)
> ✅ Sequence-aware anomaly (n-gram LM over tool calls)
> ✅ Multi-agent collusion detection
> ✅ Workflow-graph → per-node policy synthesis
> ✅ Counterfactual explainer (minimum edit to pass)

> 4/  3-layer cascade matters because the failure modes are different.
>
> L1 rules — instant block of known-bad (DROP TABLE, /etc/passwd, etc).
> L2 ML — Mahalanobis + Isolation Forest + Half-Space Trees + Conformal
> + ADWIN. Catches drift.
> L3 LLM judge — for the calls L1+L2 disagree on.

> 5/  Built on the frontier:
>
> • NIST AI RMF — 5-dimension capability risk scorer
> • OWASP LLM Top 10 — 26-pattern prompt-injection corpus
> • RFC 6962 — Merkle transparency log + zero-dep offline verifier
> • RFC 7644 SCIM 2.0 + SAML + OIDC for enterprise IdP
> • GenAI OTel semconv — flows into Datadog / Honeycomb / Tempo

> 6/  Multi-tenant from day one. 25/25 tables Postgres-ready. SCIM auto-
> provisioning + SAML + OIDC out of the box. SOC 2 evidence endpoint.
>
> Self-host via Docker, run native on macOS (Apple Silicon today,
> Windows .msi just landed), or use our hosted SaaS.

> 7/  Why bother? Because LLM apps ship to prod with no firewall.
> The category-defining post-mortems write themselves in 2026.
>
> AEGIS lets you say "we have runtime audit + policy enforcement"
> instead of "we trust the prompt."

> 8/  Free tier: 1k requests/month + 7-day audit. No card.
>
> Open source: github.com/Justin0504/Aegis
>
> If you're building agents — try it, break it, file an issue.
> If you're hiring on AI security — let's talk.
>
> Built by @aojieyuan_

---

## 2) Hacker News — Show HN

**Title:**
Show HN: AEGIS – Runtime safety layer for AI agents (open source, MIT)

**Body:**

Hi HN. I'm Justin (a USC MS student). For the last 6 months I've been
building AEGIS — an open-source runtime firewall + audit layer for AI
agents — to stop hallucinated tool calls before they hit production.

Live demo: https://aegis-marketing.aojieyuan04.workers.dev
Source: https://github.com/Justin0504/Aegis (MIT)

The pitch in one sentence: every tool call your agent makes is
classified, run through a 3-layer cascade (deterministic rules →
classical ML → LLM-judge), matched against a per-tenant policy DSL,
and audited into a cryptographically-verifiable transparency log —
all before the tool executes. Zero code change at the integration
point: customers swap one env var (`OPENAI_BASE_URL`) and every call
from any framework flows through the detector chain.

A few things I think are differentiated vs the AI-guardrail products
that are out there:

  - Cryptographic audit. Full RFC 6962 Merkle log + Sigstore-style
    witness cosignature + a zero-dep offline CLI verifier. Customers
    verify any past event without trusting AEGIS infrastructure.

  - Sequence-aware anomaly detection. Per-agent variable-order n-gram
    language model (Witten-Bell smoothed) over tool-call sequences.
    Catches the "every call individually looks normal but the order
    is wrong" class of adversarial input.

  - Multi-agent collusion detection. Cross-agent communication graph
    + three signals (handoff burst, sensitive-relay, cycle). Targets
    the SOTA failure mode named by Anthropic Agentic Misalignment 2025.

  - Workflow-aware policy generation. The scanner extracts the
    topology of LangGraph / CrewAI / AutoGen / Mastra / Vercel-AI
    apps from source. The AI policy generator consumes the graph
    and writes per-node policies keyed on real node ids — no
    inventing tool names.

  - Counterfactual explainer. When AEGIS blocks a call it returns the
    minimum edit that WOULD have passed, verified by re-running the
    AJV validator. NIST AI RMF + EU AI Act Art. 14 explainability
    ready.

Stack: TypeScript gateway + Python/JS SDKs with auto-instrumentation
for 9 LLM frameworks; SQLite by default, Postgres for HA. SCIM 2.0 +
SAML + OIDC for enterprise IdP. Tauri desktop bundle (macOS .dmg
shipping, Windows .msi just built clean). 1,145 tests across 89 suites.

Free tier: 1k req/month + 7-day audit retention, no card.

I'd love feedback — what's the failure mode you've seen in your
agents that AEGIS doesn't catch? File a GitHub issue or reply here.

---

## 3) LinkedIn

**Title block:**
🚀 AEGIS — runtime safety for AI agents — is live (and open source).

**Body:**

After 6 months of head-down building, I'm launching AEGIS — an
open-source runtime firewall + audit layer for AI agents.

The problem: LLM-driven agents ship to production with no firewall.
The first time your agent hallucinates a DROP TABLE or an outbound
email to attacker@evil.com is the day you wish you had one.

What AEGIS does:

→ Intercepts every tool call BEFORE execution
→ Runs it through a 3-layer cascade: deterministic rules → classical
  ML (Mahalanobis + Isolation Forest + Conformal + ADWIN drift) →
  LLM-judge for the borderline calls
→ Matches it against a per-tenant policy DSL with fail-safe semantics
→ Writes the verdict to a cryptographically-verifiable transparency
  log (RFC 6962 Merkle + Sigstore-style witness cosignature)
→ Streams the same trace into your existing Datadog / Honeycomb /
  Splunk via GenAI OpenTelemetry semantic conventions

Zero code change to integrate — point OPENAI_BASE_URL at the gateway
and your existing SDK calls flow through it. Five-minute setup.

What I think makes it interesting vs the existing AI-guardrail
products:

• Sequence-aware anomaly detection (n-gram LM over tool calls)
• Multi-agent collusion detection (handoff burst / sensitive relay /
  cycle)
• Workflow-graph → per-node policy synthesis (LangGraph, CrewAI,
  AutoGen, Mastra, Vercel-AI)
• Counterfactual explainer for blocked decisions
• Built-in 26-pattern prompt-injection benchmark + coverage report

Stack: TypeScript + Python + JS + Tauri desktop bundle. MIT licensed.
SCIM 2.0 + SAML + OIDC + Postgres for enterprise. 1,145 tests.

🔗 Live: https://aegis-marketing.aojieyuan04.workers.dev
⭐ GitHub: github.com/Justin0504/Aegis

Free tier ships today. If you're building agents and want runtime
guardrails — try it, break it, send feedback.

#AISecurity #LLM #OpenSource #DeveloperTools #USC

---

## 4) Where to post + when

**Order (optimised for compounding signal):**

1.  **Twitter** — first. Lowest friction. Schedule for Tue/Wed 9-11am
    PT (peak dev-Twitter window).
2.  **Hacker News** — same day, 1-2 hours after Twitter so early HN
    upvoters see Twitter buzz. Tue/Wed 9-10am PT is the sweet spot.
3.  **LinkedIn** — same day or next. Reach is slow-burn (24-72h).
4.  **/r/MachineLearning** — Sat morning, with the HN link in body.
5.  **/r/programming** — same day as HN, with screenshot.
6.  **DEV.to / Hashnode** — repost the LinkedIn copy as a blog later.

**What NOT to do early:**

- Don't pay for promo. OSS launches die in paid-traffic graveyards.
- Don't post in Discord servers you've never been in. Looks spammy.
- Don't tag major accounts unless they've already engaged with you.

---

## 5) Once you have early users — case-study outreach

Email template to send to early Free-tier signups that you can ASK
to become a design partner:

> Subject: AEGIS — quick question
>
> Hi {name},
>
> I noticed you signed up for AEGIS Free recently — thanks for trying it.
>
> I'm offering 3 month of Pro tier (normally $99/mo) for free in exchange
> for a 30-minute call where I can hear what you're protecting and what's
> missing. Two outcomes:
>
> 1. You get the full feature set (SCIM, workflow-aware policy gen,
>    collusion detector) at no cost while we're still pre-revenue.
> 2. I get to ship the feature you actually need.
>
> If a case study makes sense at month 2 or 3, I'd love to write one with
> you (optional, your name only if you say yes).
>
> Calendar: <calendly link>
>
> — Justin
