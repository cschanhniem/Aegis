/**
 * Identity stores — organizations + api_keys + org_api_keys.
 *
 * Grouped because they're all CRUD over the auth surface and share
 * the same shape: small interface, dual-backend, tenant-scoped.
 *
 *   - OrganizationsStore  per-tenant root record (id, name, slug, plan)
 *   - LegacyApiKeysStore  single-shared key (kill-switch state) — kept
 *                         for backwards compat with the v0 deployment
 *                         path where one key gates the whole gateway.
 *   - OrgApiKeysStore     per-org API keys (scoped, rate-limited,
 *                         rotatable). The production multi-tenant path.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────
// OrganizationsStore
// ─────────────────────────────────────────────────────────────────────

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface OrganizationsStore {
  init(): Promise<void>;
  insert(row: { id: string; name: string; slug: string; plan?: string; settings?: string }): Promise<void>;
  get(id: string): Promise<OrganizationRow | null>;
  getBySlug(slug: string): Promise<OrganizationRow | null>;
  list(): Promise<OrganizationRow[]>;
  updateSettings(id: string, settings: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export class SqliteOrganizationsStore implements OrganizationsStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        settings TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }
  async insert(r: { id: string; name: string; slug: string; plan?: string; settings?: string }): Promise<void> {
    this.db.prepare(
      `INSERT INTO organizations (id, name, slug, plan, settings) VALUES (?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.slug, r.plan ?? 'free', r.settings ?? '{}');
  }
  async get(id: string): Promise<OrganizationRow | null> {
    return (this.db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(id) as any) ?? null;
  }
  async getBySlug(slug: string): Promise<OrganizationRow | null> {
    return (this.db.prepare(`SELECT * FROM organizations WHERE slug = ?`).get(slug) as any) ?? null;
  }
  async list(): Promise<OrganizationRow[]> {
    return this.db.prepare(`SELECT * FROM organizations ORDER BY created_at ASC`).all() as OrganizationRow[];
  }
  async updateSettings(id: string, settings: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE organizations SET settings = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(settings, id);
    return r.changes > 0;
  }
  async delete(id: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM organizations WHERE id = ?`).run(id);
    return r.changes > 0;
  }
  async close(): Promise<void> {}
}

export class PostgresOrganizationsStore implements OrganizationsStore {
  constructor(private pool: Pool) {}
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        settings TEXT DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
  async insert(r: { id: string; name: string; slug: string; plan?: string; settings?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO organizations (id, name, slug, plan, settings) VALUES ($1, $2, $3, $4, $5)`,
      [r.id, r.name, r.slug, r.plan ?? 'free', r.settings ?? '{}'],
    );
  }
  async get(id: string): Promise<OrganizationRow | null> {
    const r = await this.pool.query(`SELECT * FROM organizations WHERE id = $1`, [id]);
    return (r.rows[0] as any) ?? null;
  }
  async getBySlug(slug: string): Promise<OrganizationRow | null> {
    const r = await this.pool.query(`SELECT * FROM organizations WHERE slug = $1`, [slug]);
    return (r.rows[0] as any) ?? null;
  }
  async list(): Promise<OrganizationRow[]> {
    const r = await this.pool.query(`SELECT * FROM organizations ORDER BY created_at ASC`);
    return r.rows as OrganizationRow[];
  }
  async updateSettings(id: string, settings: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE organizations SET settings = $1, updated_at = NOW() WHERE id = $2`,
      [settings, id],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async delete(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}

// ─────────────────────────────────────────────────────────────────────
// LegacyApiKeysStore (one row per agent; the v0 single-shared key path)
// ─────────────────────────────────────────────────────────────────────

export interface LegacyApiKeyRow {
  id: number;
  agent_id: string;
  key_hash: string;
  status: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
}

export interface LegacyApiKeysStore {
  init(): Promise<void>;
  insert(row: { agent_id: string; key_hash: string }): Promise<void>;
  findByHash(keyHash: string): Promise<LegacyApiKeyRow | null>;
  findByAgent(agentId: string): Promise<LegacyApiKeyRow | null>;
  revoke(agentId: string, reason?: string): Promise<boolean>;
  restore(agentId: string): Promise<boolean>;
  close(): Promise<void>;
}

export class SqliteLegacyApiKeysStore implements LegacyApiKeysStore {
  constructor(private db: Database.Database) {}
  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT UNIQUE NOT NULL,
        key_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        revoked_at TEXT,
        revocation_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  async insert(r: { agent_id: string; key_hash: string }): Promise<void> {
    this.db.prepare(`INSERT INTO api_keys (agent_id, key_hash) VALUES (?, ?)`).run(r.agent_id, r.key_hash);
  }
  async findByHash(h: string): Promise<LegacyApiKeyRow | null> {
    return (this.db.prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND status = 'ACTIVE'`).get(h) as any) ?? null;
  }
  async findByAgent(a: string): Promise<LegacyApiKeyRow | null> {
    return (this.db.prepare(`SELECT * FROM api_keys WHERE agent_id = ?`).get(a) as any) ?? null;
  }
  async revoke(agentId: string, reason?: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE api_keys SET status = 'REVOKED', revoked_at = datetime('now'), revocation_reason = ? WHERE agent_id = ? AND status = 'ACTIVE'`,
    ).run(reason ?? null, agentId);
    return r.changes > 0;
  }
  async restore(agentId: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE api_keys SET status = 'ACTIVE', revoked_at = NULL, revocation_reason = NULL WHERE agent_id = ?`,
    ).run(agentId);
    return r.changes > 0;
  }
  async close(): Promise<void> {}
}

export class PostgresLegacyApiKeysStore implements LegacyApiKeysStore {
  constructor(private pool: Pool) {}
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT UNIQUE NOT NULL,
        key_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        revoked_at TIMESTAMPTZ,
        revocation_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
  async insert(r: { agent_id: string; key_hash: string }): Promise<void> {
    await this.pool.query(`INSERT INTO api_keys (agent_id, key_hash) VALUES ($1, $2)`, [r.agent_id, r.key_hash]);
  }
  async findByHash(h: string): Promise<LegacyApiKeyRow | null> {
    const r = await this.pool.query(`SELECT * FROM api_keys WHERE key_hash = $1 AND status = 'ACTIVE'`, [h]);
    return (r.rows[0] as any) ?? null;
  }
  async findByAgent(a: string): Promise<LegacyApiKeyRow | null> {
    const r = await this.pool.query(`SELECT * FROM api_keys WHERE agent_id = $1`, [a]);
    return (r.rows[0] as any) ?? null;
  }
  async revoke(agentId: string, reason?: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE api_keys SET status = 'REVOKED', revoked_at = NOW(), revocation_reason = $1 WHERE agent_id = $2 AND status = 'ACTIVE'`,
      [reason ?? null, agentId],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async restore(agentId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE api_keys SET status = 'ACTIVE', revoked_at = NULL, revocation_reason = NULL WHERE agent_id = $1`,
      [agentId],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}

// ─────────────────────────────────────────────────────────────────────
// OrgApiKeysStore (per-org keys, the production path)
// ─────────────────────────────────────────────────────────────────────

export interface OrgApiKeyRow {
  id: string;
  org_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  scopes: string;
  rate_limit: number;
  created_by: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface OrgApiKeyInsert {
  id: string;
  org_id: string;
  key_hash: string;
  key_prefix: string;
  name?: string;
  scopes?: string;
  rate_limit?: number;
  created_by?: string | null;
  expires_at?: string | null;
}

export interface OrgApiKeysStore {
  init(): Promise<void>;
  insert(row: OrgApiKeyInsert): Promise<void>;
  findActiveByHash(keyHash: string): Promise<OrgApiKeyRow | null>;
  listForOrg(orgId: string): Promise<OrgApiKeyRow[]>;
  touchLastUsed(id: string): Promise<void>;
  revoke(orgId: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}

export class SqliteOrgApiKeysStore implements OrgApiKeysStore {
  constructor(private db: Database.Database) {}
  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS org_api_keys (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Default',
        scopes TEXT NOT NULL DEFAULT '["*"]',
        rate_limit INTEGER DEFAULT 1000,
        created_by TEXT,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_org_keys_org  ON org_api_keys(org_id);
      CREATE INDEX IF NOT EXISTS idx_org_keys_hash ON org_api_keys(key_hash);
    `);
  }
  async insert(r: OrgApiKeyInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO org_api_keys (id, org_id, key_hash, key_prefix, name, scopes, rate_limit, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.org_id, r.key_hash, r.key_prefix, r.name ?? 'Default', r.scopes ?? '["*"]',
          r.rate_limit ?? 1000, r.created_by ?? null, r.expires_at ?? null);
  }
  async findActiveByHash(h: string): Promise<OrgApiKeyRow | null> {
    return (this.db.prepare(
      `SELECT * FROM org_api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    ).get(h) as any) ?? null;
  }
  async listForOrg(orgId: string): Promise<OrgApiKeyRow[]> {
    return this.db.prepare(
      `SELECT * FROM org_api_keys WHERE org_id = ? ORDER BY created_at DESC`,
    ).all(orgId) as OrgApiKeyRow[];
  }
  async touchLastUsed(id: string): Promise<void> {
    this.db.prepare(`UPDATE org_api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(id);
  }
  async revoke(orgId: string, id: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE org_api_keys SET revoked_at = datetime('now') WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
    ).run(id, orgId);
    return r.changes > 0;
  }
  async close(): Promise<void> {}
}

export class PostgresOrgApiKeysStore implements OrgApiKeysStore {
  constructor(private pool: Pool) {}
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS org_api_keys (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Default',
        scopes TEXT NOT NULL DEFAULT '["*"]',
        rate_limit INTEGER DEFAULT 1000,
        created_by TEXT,
        last_used_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_org_keys_org  ON org_api_keys(org_id);
      CREATE INDEX IF NOT EXISTS idx_org_keys_hash ON org_api_keys(key_hash);
    `);
  }
  async insert(r: OrgApiKeyInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO org_api_keys (id, org_id, key_hash, key_prefix, name, scopes, rate_limit, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.id, r.org_id, r.key_hash, r.key_prefix, r.name ?? 'Default', r.scopes ?? '["*"]',
       r.rate_limit ?? 1000, r.created_by ?? null, r.expires_at ?? null],
    );
  }
  async findActiveByHash(h: string): Promise<OrgApiKeyRow | null> {
    const r = await this.pool.query(`SELECT * FROM org_api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [h]);
    return (r.rows[0] as any) ?? null;
  }
  async listForOrg(orgId: string): Promise<OrgApiKeyRow[]> {
    const r = await this.pool.query(`SELECT * FROM org_api_keys WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
    return r.rows as OrgApiKeyRow[];
  }
  async touchLastUsed(id: string): Promise<void> {
    await this.pool.query(`UPDATE org_api_keys SET last_used_at = NOW() WHERE id = $1`, [id]);
  }
  async revoke(orgId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE org_api_keys SET revoked_at = NOW() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
      [id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
