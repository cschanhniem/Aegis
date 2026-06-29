# AEGIS SaaS — hosted-product roadmap

Honest scope doc for turning AEGIS into a hosted SaaS at `app.aegistraces.com`.
None of this is built yet. This document exists so the work can be
sequenced and outsourced cleanly.

## Why a hosted version

The self-host story (Docker, Helm, Tauri desktop) is already strong, but
every B2B sales conversation will start with: *"can I get a hosted
trial?"* Without it the funnel leaks at the first email.

Plus: the most defensible parts of AEGIS (cryptographic audit log,
transparency log, multi-tenant policy + DSL evaluation) get **more**
valuable when AEGIS itself runs the audit infrastructure rather than
the customer.

## What "hosted SaaS" means concretely

A customer signs up, picks Pro / Team / Enterprise, and immediately gets:

1. `https://<their-org>.aegistraces.com` — their cockpit
2. `https://gw.aegistraces.com/v1` — shared gateway endpoint with their key
3. A real backing store with daily backups
4. The same audit-log / transparency-log they could verify offline
5. Stripe billing tied to usage (tool-call checks/month)

No infra setup on their side. No Docker. No K8s. No PVCs.

## Architecture target

```
                                  ┌─────────────────────┐
                                  │  app.aegistraces.com      │  Marketing + onboarding
                                  │  (apps/marketing)   │  (already done ✓)
                                  └─────────────────────┘
                                            │ signup → Stripe checkout
                                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  control plane                                                    │
│  ───────────────                                                  │
│  • orgs table          tenant_id → plan, billing_status, region   │
│  • users + roles       SSO providers, SCIM mappings               │
│  • api_keys            scoped to (tenant, env)                    │
│  • billing_events      from Stripe webhooks                       │
│  • backups + ledger    SHA-256-rooted, per-tenant                 │
└──────────────────────────────────────────────────────────────────┘
                                            │
                          ┌─────────────────┴────────────────┐
                          ▼                                  ▼
       ┌──────────────────────────┐         ┌──────────────────────────┐
       │  data plane — gateway    │         │  data plane — cockpit     │
       │  (k8s deployment, n>=3)  │         │  (k8s deployment, n>=2)   │
       │  pulls tenant config     │         │  reads /api/gateway/...   │
       │  evaluates policies      │         │  via control-plane auth   │
       │  writes traces to PG     │         │                           │
       └──────────────────────────┘         └──────────────────────────┘
                          │                                  │
                          └─────────────┬────────────────────┘
                                        ▼
                       ┌────────────────────────────────────┐
                       │  shared Postgres (multi-tenant)    │
                       │  row-level security by tenant_id   │
                       │  Litestream / pgbackrest to S3     │
                       └────────────────────────────────────┘
```

Single Postgres. Tenants share tables. PostgreSQL row-level security
(RLS) policies attached to `tenant_id` for hard isolation. This is
how Linear, Resend, and Cal.com run their multi-tenant data plane —
operationally cheaper than per-tenant DBs until ~1k paying tenants.

## What's already built (re-usable)

| Component | State |
|---|---|
| Gateway + cockpit Docker images | ✓ Shipped (ghcr.io) |
| AJV policy engine | ✓ |
| DSL evaluator | ✓ |
| Audit log + transparency log | ✓ (just need per-tenant scope) |
| Anomaly detector / LLM judge | ✓ |
| SCIM / SAML / OIDC for enterprise | ✓ (gateway-side) |
| 4 vertical policy packs | ✓ (just shipped) |
| Postgres store abstraction | ✓ (gateway has dual SQLite/PG; cockpit reads via API) |
| Helm chart | ✓ (just shipped, charts/aegis) |

## What's missing — the build list

### Phase 1 — beta (~3 weeks, 1 engineer)
Goal: Justin's friends can sign up, plug an SDK in, see traces.
No billing yet. Single region. Manual customer support.

- [ ] **Auth + org provisioning service**
  Hosted on the control plane. Stack: Next.js API routes + better-auth
  or Clerk. Creates `tenant_id`, generates API key, writes RLS row.
- [ ] **Tenant-scoped gateway routing**
  Gateway already accepts `X-Org-Id`; control plane needs to inject it
  from the bearer token. Add a Kong / Envoy or a small Cloudflare Worker
  in front of `gw.aegistraces.com` to do this.
- [ ] **Managed Postgres**
  Supabase or Neon for dev. RDS/Cloud SQL when scaling. Apply RLS
  policies (`tenant_isolation`) on all six core tables: agents, traces,
  policies, approvals, audit_log, anomaly_events.
- [ ] **Backups**
  Litestream → S3 for SQLite (dev only). For Postgres: pgbackrest with
  6-hour PITR (matches HIPAA retention).
- [ ] **Subdomain DNS provisioning**
  Cloudflare API. On signup, create `<slug>.aegistraces.com` CNAME → load
  balancer. Wildcard TLS already covers it.
- [ ] **Status page**
  status.aegistraces.com (use Vercel + a UptimeRobot feed, or BetterStack).

### Phase 2 — paid (~2 weeks, 1 engineer)
Goal: take credit cards. Enforce quotas.

- [ ] **Stripe integration**
  Stripe Checkout → success webhook → set `orgs.plan` + `orgs.stripe_customer`.
  Stripe Customer Portal handles upgrades/downgrades/cancellation.
- [ ] **Usage metering**
  Already have `usage_metering` table in gateway. Hourly cron rolls it
  up + bills against Stripe usage records (`subscription_items.usage_records`).
- [ ] **Quota enforcement**
  Gateway middleware returns 429 when tenant exceeds plan limit
  (1k/100k/1M tool-calls/month per Pro/Team tier).
- [ ] **Pricing page → checkout flow**
  Marketing site already has /pricing. Need a single button → Stripe
  Checkout session.

### Phase 3 — enterprise (~3 weeks, 1 engineer)
Goal: sign a Fortune 500 with airgap requirements.

- [ ] **BYOC (bring-your-own-cloud) installer**
  An enterprise customer points us at their AWS account; we run our
  Helm chart in their EKS via the Terraform module (build that here too).
- [ ] **Audit log export**
  Daily / hourly bulk export to customer's S3 / GCS.
- [ ] **Custom domain (CNAME)** for cockpit
  `audit.acme.com` → their cockpit, with their TLS cert.
- [ ] **SCIM provisioning endpoint** exposed via SaaS (already exists
  in gateway, just need to URL-expose per-tenant).
- [ ] **SOC 2 Type II report**
  Drata + a CPA engagement. ~6 months from "kickoff" to "report in
  hand". This is the long pole.

### Phase 4 — scale (~ongoing)
- [ ] Multi-region deployment (US-East + EU)
- [ ] Per-tenant rate limits + abuse protection
- [ ] Sales-led growth (CRM, lead routing, onboarding email automation)
- [ ] Marketplace listings (AWS Marketplace, Vercel Marketplace, GCP Marketplace)

## Critical decisions to make before building

### Multi-tenant DB vs per-tenant DB
**Recommendation: multi-tenant Postgres with RLS** until ~1k paying
tenants. Then graduate big customers to dedicated DB ("Enterprise
isolation tier"). Same pattern Linear / Resend use.

### Per-tenant compute vs shared compute
**Recommendation: shared.** The gateway is stateless; one fleet
serves all tenants. Add per-tenant ratelimits + isolation at the LB.
Per-tenant pods only for Enterprise tier (which is BYOC anyway).

### How to migrate self-host → hosted
**Recommendation: explicit export/import.** A `agentguard export`
emits a tarball of the customer's traces + policies + audit log; a
`agentguard import` reads it into a hosted tenant. Don't try to be
automatic. This is also the path *back* if a customer wants to
self-host again — important for trust.

### Where does cockpit run
**Recommendation: cockpit is one Next.js deploy, multi-tenant** —
shows `<org-slug>.aegistraces.com/...`. Server-side it injects the tenant
context. The cockpit code already has all the tenant-scoping; just
needs the wrapper.

## What this costs to run (rough)

| Tier | Compute | DB | Bandwidth | All-in |
|---|---|---|---|---|
| First 100 tenants (mostly Free) | $0 (Vercel) + $50 (small EC2) | $25 Supabase | $5 | **~$80/mo** |
| 100-1k tenants (mix Free + Pro) | $200 EKS small | $99 Supabase Pro | $30 | **~$330/mo** |
| 1k-10k tenants | $1.2k EKS m5.large × 3 | $499 RDS db.t4g.large | $200 | **~$1.9k/mo** |

At $19 Pro / $99 Team pricing the unit economics work out around 10
paying tenants on the 100-1k bracket. Below that we're subsidizing
Free, which is the right call for the first 6 months.

## The fastest path to first hosted customer

If you want to bias for speed:

1. **Day 1-3**: Stand up `app.aegistraces.com` on Vercel with NextAuth
   + Postgres on Supabase. Sign up flow → creates tenant row + API key.
2. **Day 4-7**: Deploy the gateway to Fly.io (uses the fly.toml we
   just shipped). Wire control plane to inject `X-Org-Id` from
   the bearer token via a Cloudflare Worker.
3. **Day 8-12**: Stripe checkout for Pro. Free tier already works.
4. **Day 13-14**: Status page + minimal docs at docs.aegistraces.com.

Two weeks. One engineer. ~$500/mo infra. First hosted customer
possible on day 15.

The Helm chart, BYOC, SOC 2 — all of that is the *enterprise* path
and can happen in parallel after the first hosted customer signs up.

## Out of scope (intentionally)

- **Marketplaces.** Wait until you have ≥ 20 paying customers.
- **Reseller program.** Wait until you've outgrown direct sales.
- **AI Gateway features** like model routing / caching / fallback.
  AEGIS is a *safety* layer, not an LLM gateway. Stay focused.
- **Building our own LLM judge.** OpenAI / Anthropic do this fine;
  AEGIS just orchestrates.
