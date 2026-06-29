# Show HN submission pack — AEGIS

This is the launch playbook for posting AEGIS to Hacker News. Copy /
paste each block; the strategy notes explain *why* each choice was
made, so you can adapt if the moment is different when you actually
post.

---

## The single most important decision: **when**

HN is a global feed but the US Pacific window dominates votes.

- **Best window:** Tuesday – Thursday, **08:00 – 10:00 Pacific** (i.e.
  16:00 – 18:00 UTC). Most US-based engineers are at their first
  coffee, refresh HN. Highest absolute traffic.
- **Second-best:** Wednesday 13:00 Pacific (US lunch).
- **Avoid:** Monday (busy week-start), Friday (people checking out),
  weekend (lower traffic + harder to chart).

A "Show HN" post lives or dies in the first 60 minutes — if it doesn't
get to ~30 upvotes in that window, it sinks. Post when you can be
**actively monitoring** for 4 hours to reply to comments.

---

## Title — A/B options

HN titles are limited to 80 chars. Three drafts, ranked by likely
upvote rate:

1. **Show HN: AEGIS – Open-source agent firewall with cryptographic audit (MIT)** ← recommended
2. **Show HN: AEGIS – We measured guard-model ECE; both OpenAI and Anthropic miscalibrate**
3. **Show HN: AEGIS – Runtime safety for AI agents (curl install.sh | sh)**

Option 1 wins because it pairs the **product noun** (firewall) with
the **differentiator** (cryptographic audit) and the **license** (MIT)
— all three are signal-rich for the HN audience. Option 2 leads with
the most interesting measurement but reads like a research post, not
a launch. Option 3 is forgettable.

Don't say "for AI agents" twice. Don't say "transformer" or "LLM" in
the title — HN audience saturates on those.

---

## Post body — the canonical text

Copy this into the body field of the Show HN submission:

```
Hi HN — I'm Justin, a USC grad student. For the last few months I've
been building AEGIS — an open-source runtime safety layer for AI
agents. It sits between the agent and its tools and decides allow /
block / escalate on every tool call, with deterministic policy +
cryptographic audit.

The thing I'm proudest of (and the thing I want HN to tear apart) is
that we actually measured what guard models do. Most "AI safety"
companies publish a comparison table; nobody publishes their Expected
Calibration Error. We did: gpt-4o-mini at 26.5% ECE, claude-haiku-4-5
at 29.2% ECE, both severely miscalibrated under jailbreak and
indirect prompt injection. Methodology + full results:
https://aegistraces.com/blog/llm-judge-calibration

The architecture (three layers):

  1. Static policy in a grammar-constrained DSL (no LLM in the loop)
  2. Sequence-aware behavioural anomaly (per-agent baseline)
  3. LLM judge — last resort, with the calibration measured above

Plus parameter-level taint propagation (FIDES + IPIGuard pattern, the
2026 SOTA for indirect prompt injection), and a Merkle-anchored audit
log with Sigstore-style witness co-signature so an auditor can verify
the log was never edited post-hoc.

Form factor is Microsoft-Word-style: `curl aegistraces.com/install
| sh`, then `aegis login`. Engine is MIT and runs entirely on your
infra — data never leaves your network. The cloud control plane is
optional and license-key gated for the Pro features (team dashboard,
policy sync, alerts). Same model as GitLab / Sentry / Tailscale.

The 12-article handbook (including all the case studies) is also
available as a 71-page PDF if you'd rather read it offline:
https://aegistraces.com/handbook.pdf

Repo: https://github.com/Justin0504/Aegis (~MIT, ~2k LoC of Rust +
TypeScript on the gateway side)

I'd love feedback on:

  - The calibration methodology — is 30 cases enough to publish? What
    benchmark cases am I missing?
  - The taint-propagation design — IPIGuard says 0.69% ASR but our
    internal numbers are ~1%. What's the right way to benchmark this?
  - The MIT + Pro tier split — does it look fair? Anything that
    should be in Community but isn't?

Happy to answer technical / architecture / commercial-model
questions in the thread.
```

**Why this body works:**
- Opens with **identity** (USC student) — HN audience respects
  builders, not "AI startups."
- Hooks with the **measurement** (real ECE numbers nobody else has
  published) — this is the differentiated insight, leads to the
  highest-comment-rate.
- Lists architecture in **3 numbered bullets** — scannable, signals
  technical seriousness without overwhelming.
- Explicit **3 questions for feedback** — invites comments rather
  than just upvotes. Comment count drives ranking.
- **No hype language** — no "revolutionary", "game-changing", "AI-
  first." HN downvotes those words.
- Links are bare (no UTM tracking) — HN sniffs and downranks tracking
  params.

---

## First-comment plan (the "OP comment")

Post this as your *first reply* to your own thread within 5 minutes
of posting:

```
A few things I deliberately left out of the post for brevity:

(1) **Why "firewall" not "guardrails"** — guardrails is fuzzy
marketing. Firewall is technically precise: a network-layer policy
enforcement device between two zones. AEGIS does exactly that — it
sits between the agent (untrusted zone) and the tools (trusted zone)
and applies a policy. The framing makes the threat model legible to
network-security people.

(2) **Why three layers, not one** — a single LLM-judge layer fails
exactly when you need it most (under jailbreak; see the calibration
data). Static rules + behavioural baselines catch the deterministic
violations cheaply (sub-50ms) so the slow LLM check only fires on
genuine edge cases. The architecture is the same shape as a content
delivery network's WAF: fast deterministic rules, then slower ML.

(3) **The cryptographic audit isn't decorative** — it's the answer
to the "how do I prove the log wasn't edited" question that
healthcare and fintech compliance teams ask 6 weeks into the security
review. RFC 6962 Merkle tree + Sigstore-style witness co-signature.
Source: https://aegistraces.com/blog/cryptographic-audit-logs-merkle-sigstore

(4) **Yes I'm aware of Lakera Guard.** They're the strongest
commercial alternative. I wrote up the comparison honestly:
https://aegistraces.com/blog/aegis-vs-lakera-guard — the short version
is they win on detector maturity and managed-service ergonomics, we
win on data sovereignty, open-source extensibility, and cryptographic
audit. Both products exist for legitimate reasons.

(5) **Funding / business model** — bootstrapped, no investors. MIT
engine forever. Pro tier ($19-99/mo, license-key) for cloud
dashboard. Same pattern as GitLab / Sentry / Tailscale. I'm a
graduate student, no rush.
```

---

## Screenshot strategy

HN posts with a **good screenshot** get 30-50% more clicks. Take
*one* screenshot at exactly **1200×675** (Open Graph dimension):

- Crop the AEGIS cockpit `/memory` page or `/violations` page
- Show **real data** (the mock data is fine — it's curated to look
  production-like)
- Include the screenshot URL in the **body** (HN doesn't render
  images, but it auto-generates the og:image preview from the linked
  page)

The **og:image** for `aegistraces.com` should be the rendered hero
animation — already set in `<Layout>` head. Verify with:
```bash
curl -s aegistraces.com | grep og:image
```

---

## Real-time playbook (the next 4 hours)

**T+0:00** — Post submitted. Open the thread in a tab.

**T+0:05** — Add the OP first-comment (above). Don't ever delete the
parent post; if you have edits, add them as additional first-level
comments.

**T+0:15** — Tweet a link to the HN post (your X/Twitter). Don't
ask people to upvote (HN bans this). Just share the URL with one
sentence: "Posted AEGIS on Show HN. The calibration numbers are the
part I want feedback on."

**T+0:30** — Reply to *every* comment, even the negative ones. Aim
for < 5 minutes response time. Comments + replies are the strongest
ranking signal.

**T+1:00** — If you're trending (Top 30 of /show), good. If not,
don't repost. Don't ask friends to upvote. Either you're on a thread
worth surfacing or you're not.

**T+4:00** — Stop refreshing. If you're on the front page now you've
made it. If not, the post will continue collecting low-traffic
upvotes from non-Show-HN browsers; let it be.

---

## Anti-patterns to avoid

1. **Don't link to a paywall.** Even a sign-up form. HN audience
   bounces.
2. **Don't ask for emails on the landing page.** Add an email
   capture *after* you've earned trust.
3. **Don't be defensive in comments.** "Actually, you're wrong" is
   never the right opener. "Fair — the way we think about it is …"
   wins.
4. **Don't repost if it flops.** Wait 14+ days. HN has a "second
   chance" pool for posts that didn't get traction first time.
5. **Don't argue with negative comments.** Acknowledge the substance,
   commit to addressing it, move on.
6. **Don't say "we" if you're solo.** HN sees through it. "I built
   …" reads better than "We built …" for a single founder.

---

## What success looks like

- **Front page (top 30)** for ≥ 1 hour → ~5–15k unique visitors,
  ~200-500 GitHub stars day-1, 1-3 inbound design-partner emails.
- **Top 10 / front of "/show" page** → ~20–50k visitors, ~500-1.5k
  stars, 5-15 inbound emails.
- **Top 5 / front page of the *site*** → ~50–100k visitors, ~1.5-4k
  stars, 20+ inbound. Genuinely rare; ~5% of Show HN posts hit this.

Median Show HN gets ~3k visitors, ~50-100 stars. Plan for the
median; the upside is the upside.

---

## Post-launch — within 24 hours

- **Sleep first.** Don't write code at midnight.
- **Triage the issues** opened against the repo. Many will be "doesn't
  install on my setup" — those become priority fixes.
- **DM the first 5 inbound design partners** within 24h. Schedule
  calls for next week.
- **Don't pivot from comments.** HN feedback is signal but not
  product strategy. Listen, filter, act on patterns not individual
  comments.

Good luck.
