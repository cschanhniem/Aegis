-- AEGIS Control Plane — initial schema.
--
-- Layered on top of the gateway's tenant-scoped tables (agents, traces,
-- policies, approvals, audit_log, anomaly_events). The gateway must be
-- pointed at the same Postgres instance via DB_URL.
--
-- After running this, EVERY query into a tenant-scoped table must run
-- inside a transaction that sets `app.tenant_id` first. The gateway's
-- request middleware does that based on X-Org-Id. RLS enforces.

-- ── Extensions ────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- ── orgs (tenants) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,                      -- subdomain
  display_name    TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free'
                    CHECK (plan IN ('free','pro','team','enterprise')),
  stripe_customer_id  TEXT,
  stripe_subscription_id TEXT,
  monthly_check_quota INTEGER NOT NULL DEFAULT 1000,
  retention_days  INTEGER NOT NULL DEFAULT 7,
  region          TEXT NOT NULL DEFAULT 'us-east',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trial_ends_at   TIMESTAMPTZ,
  suspended_at    TIMESTAMPTZ,
  suspended_reason TEXT
);
CREATE INDEX IF NOT EXISTS orgs_slug_idx ON orgs(slug);
CREATE INDEX IF NOT EXISTS orgs_stripe_idx ON orgs(stripe_customer_id);

-- ── users (auth subjects) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  email_verified TIMESTAMPTZ,
  display_name  TEXT,
  password_hash TEXT,                                        -- null for SSO
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── members (user × org × role) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  org_id    UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'admin'
              CHECK (role IN ('owner','admin','auditor','viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user_idx ON members(user_id);

-- ── api_keys (gateway authentication) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS hosted_api_keys (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL,           -- sha256(plaintext); plaintext shown once
  key_prefix TEXT NOT NULL,           -- first 8 chars, for display
  scope      TEXT NOT NULL DEFAULT 'ingest'
               CHECK (scope IN ('ingest','admin','readonly')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hosted_api_keys_org_idx ON hosted_api_keys(org_id);
CREATE INDEX IF NOT EXISTS hosted_api_keys_hash_idx ON hosted_api_keys(key_hash);

-- ── billing_events (raw Stripe webhook log) ───────────────────────────
CREATE TABLE IF NOT EXISTS billing_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES orgs(id) ON DELETE SET NULL,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed   BOOLEAN NOT NULL DEFAULT FALSE,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS billing_events_org_idx ON billing_events(org_id, received_at DESC);

-- ── usage rollups (hourly, for Stripe metered billing + quota) ────────
CREATE TABLE IF NOT EXISTS usage_rollups (
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bucket     TIMESTAMPTZ NOT NULL,
  checks     BIGINT NOT NULL DEFAULT 0,
  blocked    BIGINT NOT NULL DEFAULT 0,
  pending    BIGINT NOT NULL DEFAULT 0,
  stripe_pushed BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (org_id, bucket)
);

-- ── Row-level security on the gateway's tenant-scoped tables ──────────
--
-- The gateway already has an `org_id` column on these tables but
-- enforces tenant isolation in application code. Once we share the DB
-- across tenants, the database itself must enforce — otherwise a single
-- gateway bug = full cross-tenant leak.
--
-- Convention: every transaction sets `app.tenant_id` via:
--   SET LOCAL app.tenant_id = '<uuid>';
-- The middleware in apps/control-plane/src/lib/db.ts does this.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'agents','traces','policies','approvals',
    'audit_log','anomaly_events','tenant_config'
  ])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format(
        'DROP POLICY IF EXISTS tenant_isolation ON %I;
         CREATE POLICY tenant_isolation ON %I
           USING (org_id::text = current_setting(''app.tenant_id'', TRUE))
           WITH CHECK (org_id::text = current_setting(''app.tenant_id'', TRUE));',
        t, t
      );
    END IF;
  END LOOP;
END $$;
