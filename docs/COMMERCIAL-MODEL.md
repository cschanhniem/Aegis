# AEGIS commercial model

Cleared up for one reason: AEGIS is **MIT-licensed open source AND a paid
hosted SaaS**. That tension makes "what does paid buy me" murky. This doc
removes the murk.

## TL;DR — the four buying paths

| Path | Price | What you get | Who picks it |
|---|---|---|---|
| **Self-host OSS** | $0 (MIT) | The whole product. Same code that powers hosted. You run Docker / Helm / K8s on your own infra. Community Slack support. | Engineers who want full control, run on-prem, regulated environments that can't send traces off-prem, hobbyists, security-paranoid orgs. |
| **Hosted Free** | $0 forever | Same product, our infra. 1k tool-call checks/mo, 7-day retention, 1 seat. | Solo devs trying it out. SaaS-curious. Personal projects. |
| **Hosted Pro / Team** | $19 / $99 mo | Same product, our infra, real quota, SLA-backed support, SSO. | Startups + mid-market teams who don't want to run Docker. |
| **Hosted Enterprise** | Custom (typically $2k+ mo) | BYOC (bring-your-own-cloud) or dedicated tenant. SOC 2 evidence pack we share from our audit. Named success engineer. Custom SLA. | Regulated industries — fintech, healthcare, gov. |

**You never pay AEGIS for "features that aren't in the OSS download"** —
the bits are identical. You pay AEGIS for the *operations* (we run the
boxes), the *trust* (we sign our SOC 2 report and let you reference it),
and the *support* (named human you can page).

That's the entire commercial story. Everything below is detail.

---

## What "self-host" actually includes

`git clone && docker compose up -d` gets you:

- Gateway with all 7 default policies + the 4 vertical packs
- Cockpit dashboard
- Full detector chain — rules / ML anomaly / LLM judge
- DSL custom rules + the AI policy generator
- Cryptographic Merkle audit log + transparency log
- Compliance bundle generation (SOC 2 / ISO 27001 / NIST AI RMF / EU AI Act)
- Multi-tenant + RBAC + SCIM + SAML adapters
- All SDKs (Python / JS / Go) from public package registries

**Nothing is "license-tier locked" in practice.** The `AEGIS_LICENSE_TIER`
env var gates a few features (anomaly, judge, audit-log endpoint, etc.)
but it's an honor-system flag — anyone running the OSS code can set
`AEGIS_LICENSE_TIER=enterprise` and unlock everything. We don't ship a
license server.

This is intentional. AEGIS is a *security* product — closed-source
security is a contradiction. Buyers need to read the code. So MIT.

## What hosted adds (and why it's worth paying for)

What you genuinely don't get from `docker compose up`:

| Thing | Self-host you | Hosted us |
|---|---|---|
| **Postgres ops** | Your problem. Backups, failover, schema migrations on upgrade. | Managed. Hourly PITR. Multi-AZ. |
| **TLS / certs** | Your problem. Cert-manager + Let's Encrypt + renewal. | Automatic. Wildcard *.aegistraces.com. |
| **Status page** | You build / buy one. | status.aegistraces.com. |
| **Witness signatures on transparency log** | Run your own witness (we ship the binary, but you operate it). | We co-sign every batch and publish the signing key. Audit-grade. |
| **Upgrade cadence** | When you find time. | Continuous deploy; you wake up to new policies + detector tweaks. |
| **SOC 2 Type II report** | You'd have to commission your own audit. | We share OUR report — you reference it in your customers' security reviews. |
| **24×7 on-call** | You. | Us, with PagerDuty, on Team+ tiers. |
| **Compliance officer's headache** | "How do we PROVE the gateway isn't tampered with?" → you build it. | We hold the keys; you get the artifacts. |

Look at it this way: the OSS download is the *engine*. The hosted SaaS is
*us running the car for you* — fuel, oil changes, brake jobs, registration,
parking. Engine is free either way.

## Concrete tier differences (hosted)

|  | Free | Pro $19/mo | Team $99/mo | Enterprise Custom |
|---|---|---|---|---|
| **Tool-call checks / mo** | 1,000 | 100,000 | 1,000,000 | Unlimited |
| **Orgs** | 1 | 5 | Unlimited | Unlimited |
| **Agents** | 5 | 100 | Unlimited | Unlimited |
| **Audit retention** | 7 days | 30 days | 90 days | Custom (years) |
| **Seats** | 1 | 3 | 10 | Unlimited |
| **Vertical policy packs** | All 4 | All 4 | All 4 | All 4 + custom |
| **SSO** | — | OIDC + Google + GitHub | + SAML + SCIM | + ADFS + Shibboleth + custom |
| **Witness cosignature** | — | — | ✓ | ✓ |
| **PI corpus + coverage report** | — | — | ✓ | ✓ |
| **Policy-effectiveness scoring (P/R/F1)** | — | — | ✓ | ✓ |
| **SOC 2 Type II evidence** | — | — | — | ✓ |
| **99.9% SLA + PagerDuty** | — | — | — | ✓ |
| **BYOC / on-prem deploy** | — | — | — | ✓ |
| **MSA / DPA / BAA** | — | — | — | ✓ |
| **Support** | Community Slack | Email, 1-business-day | Priority Slack | Named success eng + quarterly review |
| **Billing** | — | Credit card via Stripe | Credit card via Stripe | Invoice / NET-30 |

## What CAN'T you do under the MIT license

Almost nothing. The license is permissive. You can:

- Use AEGIS commercially in your own product
- Modify it
- Run it on your customers' infra and charge them
- Sell support for it
- Re-license your fork

You can't:

- Remove the copyright notice
- Hold AEGIS contributors liable (standard MIT warranty disclaimer)
- Use the AEGIS name/logo for your fork without permission (trademark,
  not copyright — separate)

## The single line that explains the ask

> "AEGIS the code is free. Hosted AEGIS the *service* costs money,
> because someone has to run Postgres and sign the SOC 2 report."

Put this on the pricing page. Put it in pitch decks. Don't try to obscure
which buy you're asking customers to make.

## Download vs. signup — what the marketing site should say

Visitors land on `aegistraces.com`. They see two paths, equally valid:

1. **Download / self-host** — `curl install.sh | bash` or the four
   1-click deploy buttons. Free, MIT, takes 30 seconds.
2. **Sign up for hosted** — `app.aegistraces.com/signup`. Free tier or
   credit-card upgrade. Takes 30 seconds.

Both buttons should be the same visual weight. Don't bury self-host.
Buyers who want self-host SOMETIMES later become paid hosted customers
(team grew, infra became a headache). Buyers who go straight to hosted
appreciate self-host as a "lock-in escape hatch" — they pay knowing they
can leave.

The pricing page should literally have a **"Self-host"** column to the
LEFT of the four hosted tiers, with "$0 — run on your own infra" on top.
It should win on price (it's free) and lose on operations (you do the
work). That's the deal.
