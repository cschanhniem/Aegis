/**
 * PolicyStore — a typed, async storage interface for the `policies` table.
 *
 * Why this exists: PolicyEngine used to call `db.prepare(...).run(...)`
 * directly against better-sqlite3, which is a sync-only API tied to one
 * specific driver. For B2B SaaS / on-prem Postgres deployments we need
 * to (a) support a real RDBMS for HA + horizontal scale, (b) keep the
 * existing single-binary SQLite path intact for solo deploys.
 *
 * Migration strategy: rather than rewrite 70 call sites at once, we
 * abstract the SAFETY-CRITICAL table (policies) first. PolicyEngine
 * talks to this store interface; the rest of the gateway keeps
 * better-sqlite3 calls for now. Subsequent tables (violations, traces,
 * gateway_config, etc.) follow the same Store pattern as we go.
 *
 * Both adapter implementations live in db/sqlite-policy-store.ts and
 * db/postgres-policy-store.ts respectively. The factory pickPolicyStore
 * inspects `process.env.DATABASE_URL`:
 *   - undefined / sqlite://... / file://... → SqlitePolicyStore (default)
 *   - postgres://... / postgresql://...    → PostgresPolicyStore
 *
 * The wildcard semantics (org_id='*' = platform default, tenant rows
 * shadow wildcards on `name`) are enforced inside each adapter — the
 * Engine doesn't care which backend it talks to.
 */

import type Database from 'better-sqlite3';

export const PLATFORM_ORG = '*';

export interface PolicyRow {
  id: string;
  name: string;
  description: string | null;
  policy_schema: string;   // raw JSON text — parsed by caller
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  enabled: number;         // 0 or 1 (kept as int for cross-driver portability)
  org_id: string;
  created_at?: string;
  updated_at?: string;
}

export interface PolicyUpsert {
  id: string;
  name: string;
  description: string;
  policy_schema: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  org_id: string;
}

export interface PolicyStore {
  /** Initialise the underlying schema (idempotent). */
  init(): Promise<void>;

  /** All enabled wildcard policies — applied to every tenant. */
  listEnabledWildcards(): Promise<PolicyRow[]>;

  /** All enabled rows scoped to a specific tenant. */
  listEnabledForOrg(orgId: string): Promise<PolicyRow[]>;

  /** Admin / cockpit-style view: every row visible to one org
   *  (wildcards + tenant), ordered with tenant rows first. */
  listAllForOrg(orgId: string): Promise<PolicyRow[]>;

  /** Every row across every org (operator-level only). */
  listAll(): Promise<PolicyRow[]>;

  /** Insert OR update (idempotent on id). */
  upsert(row: PolicyUpsert): Promise<void>;

  /** Enable / disable preserve org isolation: a tenant row is flipped
   *  if it exists, otherwise the wildcard is touched (so disabling a
   *  platform default still works for legacy single-tenant ops). */
  setEnabledForOrg(policyId: string, orgId: string, enabled: boolean): Promise<{ scope: 'tenant' | 'wildcard'; changed: boolean }>;

  /** Hard delete a row scoped to one org. */
  deleteForOrg(policyId: string, orgId: string): Promise<{ deleted: boolean }>;

  /** Close any underlying resources (pg pool, etc.). No-op on SQLite. */
  close(): Promise<void>;
}

/** Choose the right backend based on env. Pure factory — no side
 *  effects beyond opening connections. SQLite stays the default so
 *  existing deploys behave unchanged. */
export async function pickPolicyStore(
  fallbackSqliteDb: Database.Database,
): Promise<PolicyStore> {
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (!url || url.startsWith('sqlite://') || url.startsWith('file://')) {
    const { SqlitePolicyStore } = await import('./sqlite-policy-store');
    const store = new SqlitePolicyStore(fallbackSqliteDb);
    await store.init();
    return store;
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { PostgresPolicyStore } = await import('./postgres-policy-store');
    const store = new PostgresPolicyStore(url);
    await store.init();
    return store;
  }
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.slice(0, 32)}…`);
}
