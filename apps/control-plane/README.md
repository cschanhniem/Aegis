# AEGIS Control Plane

Hosted-SaaS front door. Sits at `app.aegis.dev` and:

1. Signs people up (email / SSO).
2. Provisions a tenant: row in `orgs`, generated API key, Cloudflare DNS
   record for `<slug>.aegis.dev` cockpit, Stripe customer.
3. Authenticates dashboard requests + proxies them to the shared
   gateway with `X-Org-Id` injected.
4. Receives Stripe webhooks → updates plan + quota.

The data plane (gateway + cockpit Docker images) is unchanged. This
app is the *control* layer that turns those images into a multi-tenant
hosted product.

## Status — scaffolding only

What's here:

- Next.js 14 app skeleton
- API routes for: signup, login session, tenant create, Stripe checkout
  session, Stripe webhook, gateway proxy
- Postgres migrations: `orgs`, `users`, `members`, `billing_events`,
  RLS policies on the gateway's tenant-scoped tables
- Env var contract documented in `.env.example`

What's **not** here (needs a real engineer + your accounts):

- Actual UI (just stub pages)
- Real auth provider config (placeholder for next-auth + Clerk fallback)
- Cloudflare DNS automation (env var stubs only)
- Production deploy (Vercel project + Supabase / Neon Postgres)

This commit ships the *contract* so the work can be sequenced and
estimated. See `docs/SAAS-ROADMAP.md` for the phased plan.

## Local dev

```bash
cd apps/control-plane
cp .env.example .env.local
# edit .env.local with Postgres URL + Stripe keys + Cloudflare token

npm install
npm run migrate
npm run dev          # http://localhost:14000
```

## Production deploy (recipe)

1. **Postgres** — Supabase project. Run `npm run migrate` against it.
   Note: this is the **same** DB the gateway reads/writes, just with
   the SaaS-only tables (`orgs`, `users`, `members`, `billing_events`)
   layered on top and RLS policies applied to every tenant-scoped
   table. The gateway then runs with `DB_URL` pointing at the same
   instance; each request carries `X-Org-Id`, RLS does the isolation.

2. **Vercel** — point this directory as the project root. Set the env
   vars from `.env.example`.

3. **Gateway** — deploy to Fly.io (using `fly.toml` we shipped),
   set `DB_URL` to the Postgres URL, set `AEGIS_LICENSE_TIER=pro`.
   Route `https://gw.aegis.dev/*` → Fly app via a Cloudflare Worker
   that adds `X-Org-Id` from the bearer token.

4. **Stripe** — create products + prices for Pro / Team. Point the
   webhook at `https://app.aegis.dev/api/stripe/webhook`. Set
   `STRIPE_WEBHOOK_SECRET`.

5. **Cloudflare** — wildcard `*.aegis.dev` → cockpit (subdomain in
   request resolves to tenant via the control-plane proxy). API token
   with DNS edit scope so the control plane can create CNAME records.

## Endpoints (contract)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | Email + password → create org + send verify email |
| POST | `/api/auth/login`  | Email + password → session cookie |
| GET  | `/api/me`          | Current user + active tenant |
| POST | `/api/tenants`     | Create a new org for the logged-in user |
| GET  | `/api/tenants/:id/api-key` | Reveal the gateway API key (only once after creation) |
| POST | `/api/billing/checkout` | Stripe Checkout session for plan upgrade |
| POST | `/api/stripe/webhook`  | Stripe webhook handler (signature-verified) |
| ALL  | `/api/gw/[...path]` | Authenticated proxy to gateway with X-Org-Id injected |
