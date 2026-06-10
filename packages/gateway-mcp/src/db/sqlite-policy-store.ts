/**
 * SqlitePolicyStore — implements PolicyStore on top of better-sqlite3.
 *
 * Synchronous driver calls wrapped in Promises so the interface is
 * uniform with the Postgres adapter. Better-sqlite3 is reliable and
 * fast at low concurrency — this is the right backend for solo,
 * desktop, and single-server deploys.
 */

import type Database from 'better-sqlite3';
import type { PolicyStore, PolicyRow, PolicyUpsert } from './policy-store';
import { PLATFORM_ORG } from './policy-store';

export class SqlitePolicyStore implements PolicyStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    // The main schema bootstrap (in database.ts) already creates the
    // table + org_id column + index. We assert the columns exist as a
    // safety net for tests that hand us a bare db.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        policy_schema TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        org_id TEXT NOT NULL DEFAULT '*'
      );
      CREATE INDEX IF NOT EXISTS idx_policies_org ON policies (org_id, enabled);
    `);
    try { this.db.exec(`ALTER TABLE policies ADD COLUMN org_id TEXT NOT NULL DEFAULT '*'`); } catch { /* exists */ }
  }

  async listEnabledWildcards(): Promise<PolicyRow[]> {
    return this.db.prepare(`SELECT * FROM policies WHERE enabled = 1 AND org_id = ?`).all(PLATFORM_ORG) as PolicyRow[];
  }

  async listEnabledForOrg(orgId: string): Promise<PolicyRow[]> {
    return this.db.prepare(`SELECT * FROM policies WHERE enabled = 1 AND org_id = ?`).all(orgId) as PolicyRow[];
  }

  async listAllForOrg(orgId: string): Promise<PolicyRow[]> {
    return this.db.prepare(
      `SELECT * FROM policies WHERE org_id = ? OR org_id = ?
       ORDER BY (org_id = ?) DESC, created_at ASC`,
    ).all(orgId, PLATFORM_ORG, orgId) as PolicyRow[];
  }

  async listAll(): Promise<PolicyRow[]> {
    return this.db.prepare(`SELECT * FROM policies ORDER BY org_id, created_at ASC`).all() as PolicyRow[];
  }

  async upsert(row: PolicyUpsert): Promise<void> {
    this.db.prepare(`
      INSERT INTO policies (id, name, description, policy_schema, risk_level, enabled, org_id)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        policy_schema = excluded.policy_schema,
        risk_level = excluded.risk_level,
        enabled = excluded.enabled,
        org_id = excluded.org_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(row.id, row.name, row.description, row.policy_schema, row.risk_level, row.org_id);
  }

  async setEnabledForOrg(
    policyId: string,
    orgId: string,
    enabled: boolean,
  ): Promise<{ scope: 'tenant' | 'wildcard'; changed: boolean }> {
    const flag = enabled ? 1 : 0;
    const info = this.db.prepare(
      `UPDATE policies SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND org_id = ?`,
    ).run(flag, policyId, orgId);
    if (info.changes > 0) return { scope: 'tenant', changed: true };
    // Fall back to wildcard scope for the legacy single-tenant case.
    const fb = this.db.prepare(
      `UPDATE policies SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND org_id = ?`,
    ).run(flag, policyId, PLATFORM_ORG);
    return { scope: 'wildcard', changed: fb.changes > 0 };
  }

  async deleteForOrg(policyId: string, orgId: string): Promise<{ deleted: boolean }> {
    const info = this.db.prepare(`DELETE FROM policies WHERE id = ? AND org_id = ?`).run(policyId, orgId);
    return { deleted: info.changes > 0 };
  }

  async close(): Promise<void> { /* better-sqlite3 owns its handle lifecycle */ }
}
