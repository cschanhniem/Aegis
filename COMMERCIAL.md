# AEGIS — Commercial Use & Enterprise Support

**TL;DR** — AEGIS is MIT-licensed and free for any use, including
production deployments inside your own infrastructure. The
commercial offering below is **optional**, addressed to teams that
need a contractual relationship with the maintainers (support SLA,
indemnification, custom work, prioritised features). You can keep
running AEGIS off `main` for free indefinitely.

> ⚠️ **This document is a draft for review by counsel.** Nothing
> here is a binding contract. The current binding license remains
> [MIT](LICENSE) until a signed agreement says otherwise.

---

## What MIT (the OSS license) already gives you

The full text lives in [`LICENSE`](LICENSE). In plain English:

- **Use freely.** Self-host, embed in internal tools, run on
  production traffic, deploy across any cloud or on-prem — no
  permission required, no royalty.
- **Modify freely.** Fork the repo, change anything, ship the
  modified version.
- **Redistribute freely.** Ship binaries, docker images, derived
  works — provided the MIT copyright notice stays in the source.
- **No warranty.** Software is provided "as is." Maintainers are
  not liable for damages from defects.
- **No support obligation.** GitHub issues are best-effort.

Most users — solo developers, internal teams, hobbyists,
researchers — are fully served by MIT and need nothing more from
this page.

---

## When the commercial offering is for you

You probably want a commercial agreement if your organisation
needs at least one of:

1. **Indemnification.** Contractual coverage if a third party
   claims AEGIS infringes their IP.
2. **Warranty above "as is."** Written commitment to a working
   state, with remediation timelines.
3. **Support SLA.** A response-time guarantee on production
   incidents (vs best-effort issues).
4. **Custom features / private fork.** Work on top of upstream
   reserved for your tenancy.
5. **Embedded redistribution.** Bundling AEGIS inside a closed-
   source product you ship to customers (MIT permits this, but
   enterprise legal often still wants a separate paper trail).
6. **Audit cooperation.** Help responding to your customers'
   security questionnaires (SOC 2 evidence pack walk-through,
   penetration-test result sharing, vendor onboarding forms).

If none of these apply, you don't need commercial. Don't pay for
what you don't use.

---

## What's offered (subject to negotiation)

| Tier              | Audience                                | Includes                                                                                                          | Pricing          |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **Community**     | Anyone running AEGIS off `main`         | Public GitHub issues, public roadmap, public docs                                                                  | Free (MIT)       |
| **Pilot**         | Single team, evaluation period          | Email support (48h target), monthly office-hour call, copy of latest SOC 2 evidence pack                          | Negotiated       |
| **Standard**      | Production usage at one organisation    | All Pilot + indemnification + 24h SLA on Sev-1 + named contact + roadmap influence                                | Negotiated       |
| **Embedded**      | Bundling AEGIS inside your own product  | All Standard + private fork branch + permission to drop "AEGIS" branding + co-marketing optional                  | Negotiated       |

All tiers are negotiated case-by-case at this stage. There is no
self-serve checkout. Reach the maintainer at
[aojieyua@usc.edu](mailto:aojieyua@usc.edu) with:

- Your organisation's size and industry
- The deployment shape (self-host / SaaS embed / on-prem)
- Which of the six "you need this if…" reasons above apply
- A rough timeline

You'll get a concrete proposal back within 5 business days or a
clear "this isn't the right time for either of us."

---

## What's *not* gated behind a commercial agreement

Things the open-source build will always include:

- The full classifier + policy engine + DSL
- Every SDK (Python / JS / Go)
- The Cockpit UI source code
- The MCP servers (WebSocket + stdio)
- The audit-chain integrity verification path
- The signed evidence pack export
- Every test, every example, every doc page in this repo

We do **not** plan an open-core split (keeping critical features
behind a paywall while marketing the OSS version). The commercial
offering is about the *relationship*, not feature gating.

---

## Compatibility with the OSS license

The commercial agreement does **not** replace MIT for the code
you receive — it adds contractual commitments *on top of* MIT.
That means:

- You can run the same AEGIS binary under MIT (for one part of
  your org) and under a commercial agreement (for another part)
  — they're the same software.
- A commercial customer can still fork the code and run the fork
  under MIT — the commercial agreement is between people, not
  code.
- A commercial agreement is *additive*, never restrictive of the
  rights MIT already grants.

---

## A note on AGPL / BSL

AEGIS is **not** AGPL or BSL today. The OSS license is permissive
on purpose: the cost of restricting redistribution would, at this
stage, be larger than the hypothetical SaaS-clone revenue it would
defend. The choice is reviewable — if a meaningful number of
customers reach the Embedded tier, we will revisit. Any license
change would be announced in advance and apply only to versions
released after the change, never retroactively.

---

## Trademark + brand

See [TRADEMARK.md](TRADEMARK.md) for what use of the "AEGIS" name
and logo is permitted under MIT vs requires permission.
