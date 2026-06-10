/**
 * PostgresPolicyStore — implements PolicyStore on top of node-postgres.
 *
 * Activated when `DATABASE_URL=postgres://...` is set. Uses a single
 * pool per process; queries are parameterised with $1, $2, … (pg style)
 * which the adapter translates from the canonical "?" style used by
 * the SQLite adapter — same SQL author, different placeholder dialect.
 *
 * Concurrency: pg is async by nature and the pool handles request
 * fan-out. We DO NOT prepare statements explicitly — node-postgres
 * caches plans by parameter signature, and the policies hot-path has
 * < 10 distinct queries.
 *
 * Tested against pg-mem in-process; the same code runs unmodified
 * against a real Postgres ≥ 13 (ON CONFLICT and parameterised queries
 * are both standard since 9.5).
 */

import { Pool } from 'pg';
import type { PolicyStore, PolicyRow, PolicyUpsert } from './policy-store';
import { PLATFORM_ORG } from './policy-store';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    policy_schema TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    org_id TEXT NOT NULL DEFAULT '*'
  );
  CREATE INDEX IF NOT EXISTS idx_policies_org ON policies (org_id, enabled);
`;

export class PostgresPolicyStore implements PolicyStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  /** pg-mem doesn't expose a Pool — let tests inject one directly.
   *  Real production code goes through the connection-string ctor. */
  static fromPool(pool: Pool): PostgresPolicyStore {
    const inst = Object.create(PostgresPolicyStore.prototype) as PostgresPolicyStore;
    (inst as any).pool = pool;
    return inst;
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async listEnabledWildcards(): Promise<PolicyRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM policies WHERE enabled = 1 AND org_id = $1`, [PLATFORM_ORG]);
    return rows as PolicyRow[];
  }

  async listEnabledForOrg(orgId: string): Promise<PolicyRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM policies WHERE enabled = 1 AND org_id = $1`, [orgId]);
    return rows as PolicyRow[];
  }

  async listAllForOrg(orgId: string): Promise<PolicyRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM policies WHERE org_id = $1 OR org_id = $2
       ORDER BY (org_id = $1) DESC, created_at ASC`,
      [orgId, PLATFORM_ORG],
    );
    return rows as PolicyRow[];
  }

  async listAll(): Promise<PolicyRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM policies ORDER BY org_id, created_at ASC`);
    return rows as PolicyRow[];
  }

  async upsert(row: PolicyUpsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO policies (id, name, description, policy_schema, risk_level, enabled, org_id)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         policy_schema = EXCLUDED.policy_schema,
         risk_level = EXCLUDED.risk_level,
         enabled = EXCLUDED.enabled,
         org_id = EXCLUDED.org_id,
         updated_at = NOW()`,
      [row.id, row.name, row.description, row.policy_schema, row.risk_level, row.org_id],
    );
  }

  async setEnabledForOrg(
    policyId: string,
    orgId: string,
    enabled: boolean,
  ): Promise<{ scope: 'tenant' | 'wildcard'; changed: boolean }> {
    const flag = enabled ? 1 : 0;
    const r1 = await this.pool.query(
      `UPDATE policies SET enabled = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
      [flag, policyId, orgId],
    );
    if ((r1.rowCount ?? 0) > 0) return { scope: 'tenant', changed: true };
    const r2 = await this.pool.query(
      `UPDATE policies SET enabled = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
      [flag, policyId, PLATFORM_ORG],
    );
    return { scope: 'wildcard', changed: (r2.rowCount ?? 0) > 0 };
  }

  async deleteForOrg(policyId: string, orgId: string): Promise<{ deleted: boolean }> {
    const r = await this.pool.query(`DELETE FROM policies WHERE id = $1 AND org_id = $2`, [policyId, orgId]);
    return { deleted: (r.rowCount ?? 0) > 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
