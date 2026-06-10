/**
 * ScimTokenStore — bearer-token persistence for SCIM provisioning.
 *
 * Hashed at rest (sha256). Plaintext is only ever emitted once at
 * creation. Per-org isolation is enforced inside the store; tokens
 * cannot cross-tenant.
 *
 * Same one-interface-two-adapters pattern as the other stores.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface ScimTokenRow {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ScimTokenStore {
  init(): Promise<void>;
  insert(opts: { id: string; orgId: string; name: string; tokenHash: string }): Promise<void>;
  resolveOrg(tokenHash: string): Promise<string | null>;
  list(orgId: string): Promise<ScimTokenRow[]>;
  revoke(orgId: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteScimTokenStore implements ScimTokenStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scim_tokens (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scim_tokens_org ON scim_tokens(org_id);
    `);
  }

  async insert(opts: { id: string; orgId: string; name: string; tokenHash: string }): Promise<void> {
    this.db.prepare(
      `INSERT INTO scim_tokens (id, org_id, name, token_hash) VALUES (?, ?, ?, ?)`,
    ).run(opts.id, opts.orgId, opts.name, opts.tokenHash);
  }

  async resolveOrg(tokenHash: string): Promise<string | null> {
    const row = this.db.prepare(
      `SELECT org_id FROM scim_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
    ).get(tokenHash) as any;
    return row?.org_id ?? null;
  }

  async list(orgId: string): Promise<ScimTokenRow[]> {
    return this.db.prepare(
      `SELECT id, org_id, name, created_at, revoked_at FROM scim_tokens
       WHERE org_id = ? ORDER BY created_at DESC`,
    ).all(orgId) as any;
  }

  async revoke(orgId: string, id: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE scim_tokens SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
    ).run(id, orgId);
    return r.changes > 0;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scim_tokens (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_scim_tokens_org ON scim_tokens(org_id);
`;

export class PostgresScimTokenStore implements ScimTokenStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(opts: { id: string; orgId: string; name: string; tokenHash: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO scim_tokens (id, org_id, name, token_hash) VALUES ($1, $2, $3, $4)`,
      [opts.id, opts.orgId, opts.name, opts.tokenHash],
    );
  }

  async resolveOrg(tokenHash: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT org_id FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return r.rows[0]?.org_id ?? null;
  }

  async list(orgId: string): Promise<ScimTokenRow[]> {
    const r = await this.pool.query(
      `SELECT id, org_id, name, created_at, revoked_at FROM scim_tokens
       WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId],
    );
    return r.rows as any;
  }

  async revoke(orgId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE scim_tokens SET revoked_at = NOW()
       WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
      [id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
