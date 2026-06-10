/**
 * UserStore — workforce / tenant-admin identity records.
 *
 * Backs both RbacService (cockpit user management) and ScimService
 * (IdP-driven provisioning). The two consumers see the same row shape
 * — only the WRITE path differs (a UI-issued create vs an Okta SCIM
 * POST), so unifying them behind one store is the right factoring.
 *
 * Column model:
 *   id            UUID, lowercase
 *   org_id        tenant boundary; every query scopes by this
 *   email         the SCIM `userName` AND the cockpit login identity
 *   role          'owner' | 'admin' | 'auditor' | 'viewer' (RBAC)
 *   status        'active' | 'disabled' (soft-deactivation)
 *   external_id   IdP-side stable id (SCIM); UNIQUE per (org_id, ext_id)
 *   given_name / family_name / name   SCIM structured name + display
 *   password_hash optional local-password column (legacy)
 *   last_login    informational
 *   created_at / updated_at
 *
 * Tenant isolation: every method takes orgId. Cross-tenant access is
 * impossible from the public API.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export type Role = 'owner' | 'admin' | 'auditor' | 'viewer';

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string | null;
  role: Role;
  status: string;
  external_id: string | null;
  given_name: string | null;
  family_name: string | null;
  password_hash?: string | null;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserInsert {
  id: string;
  org_id: string;
  email: string;
  name?: string | null;
  role?: Role;
  status?: 'active' | 'disabled';
  external_id?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  password_hash?: string | null;
}

export interface UserListOpts {
  org_id: string;
  limit?: number;
  offset?: number;
  /** Compiled SQL fragment used by SCIM filter — `{ where, params }`. */
  whereExtra?: { where: string; params: any[] };
  orderBy?: string;
}

export interface UserStore {
  init(): Promise<void>;
  insert(row: UserInsert): Promise<void>;
  /** Find by primary key + tenant. Returns null if not found OR if the
   *  row belongs to a different tenant. */
  get(orgId: string, id: string): Promise<UserRow | null>;
  getByEmail(orgId: string, email: string): Promise<UserRow | null>;
  getByExternalId(orgId: string, externalId: string): Promise<UserRow | null>;
  list(opts: UserListOpts): Promise<{ entries: UserRow[]; total: number }>;
  update(orgId: string, id: string, patch: Partial<UserInsert>): Promise<void>;
  setColumn(orgId: string, id: string, col: string, value: any): Promise<void>;
  delete(orgId: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}

const ALLOWED_COLS = new Set([
  'email', 'name', 'role', 'status', 'external_id',
  'given_name', 'family_name', 'password_hash', 'last_login',
]);

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteUserStore implements UserStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'viewer',
        password_hash TEXT,
        last_login TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        external_id TEXT,
        given_name TEXT,
        family_name TEXT,
        UNIQUE(org_id, email)
      );
      CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_scim_extid ON users(org_id, external_id) WHERE external_id IS NOT NULL;
    `);
    // Some columns may pre-exist on legacy DBs — ALTER for forward-compat.
    for (const col of ['external_id', 'given_name', 'family_name']) {
      try { this.db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`); } catch { /* exists */ }
    }
  }

  async insert(row: UserInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO users (id, org_id, email, name, role, status, external_id, given_name, family_name, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.org_id, row.email, row.name ?? null,
      row.role ?? 'viewer', row.status ?? 'active',
      row.external_id ?? null, row.given_name ?? null, row.family_name ?? null,
      row.password_hash ?? null,
    );
  }

  async get(orgId: string, id: string): Promise<UserRow | null> {
    return (this.db.prepare(`SELECT * FROM users WHERE id = ? AND org_id = ?`).get(id, orgId) as any) ?? null;
  }

  async getByEmail(orgId: string, email: string): Promise<UserRow | null> {
    return (this.db.prepare(`SELECT * FROM users WHERE org_id = ? AND email = ?`).get(orgId, email) as any) ?? null;
  }

  async getByExternalId(orgId: string, externalId: string): Promise<UserRow | null> {
    return (this.db.prepare(`SELECT * FROM users WHERE org_id = ? AND external_id = ?`).get(orgId, externalId) as any) ?? null;
  }

  async list(opts: UserListOpts): Promise<{ entries: UserRow[]; total: number }> {
    let where = `org_id = ?`;
    const params: any[] = [opts.org_id];
    if (opts.whereExtra) {
      where += ` AND ${opts.whereExtra.where}`;
      params.push(...opts.whereExtra.params);
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`).get(...params) as any).n;
    const limit = Math.min(opts.limit ?? 100, 200);
    const offset = opts.offset ?? 0;
    const order = opts.orderBy ?? 'created_at ASC';
    const entries = this.db.prepare(
      `SELECT * FROM users WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as UserRow[];
    return { entries, total };
  }

  async update(orgId: string, id: string, patch: Partial<UserInsert>): Promise<void> {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === 'org_id') continue;
      if (!ALLOWED_COLS.has(k)) continue;
      sets.push(`${k} = ?`);
      args.push(v ?? null);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...args, id, orgId);
  }

  async setColumn(orgId: string, id: string, col: string, value: any): Promise<void> {
    if (!ALLOWED_COLS.has(col)) throw new Error(`setColumn: column not whitelisted: ${col}`);
    this.db.prepare(
      `UPDATE users SET ${col} = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?`,
    ).run(value, id, orgId);
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM users WHERE id = ? AND org_id = ?`).run(id, orgId);
    return r.changes > 0;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',
    password_hash TEXT,
    last_login TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    external_id TEXT,
    given_name TEXT,
    family_name TEXT,
    UNIQUE (org_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_scim_extid ON users(org_id, external_id) WHERE external_id IS NOT NULL;
`;

export class PostgresUserStore implements UserStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(row: UserInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, org_id, email, name, role, status, external_id, given_name, family_name, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id, row.org_id, row.email, row.name ?? null,
        row.role ?? 'viewer', row.status ?? 'active',
        row.external_id ?? null, row.given_name ?? null, row.family_name ?? null,
        row.password_hash ?? null,
      ],
    );
  }

  async get(orgId: string, id: string): Promise<UserRow | null> {
    const r = await this.pool.query(`SELECT * FROM users WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (r.rows[0] as any) ?? null;
  }

  async getByEmail(orgId: string, email: string): Promise<UserRow | null> {
    const r = await this.pool.query(`SELECT * FROM users WHERE org_id = $1 AND email = $2`, [orgId, email]);
    return (r.rows[0] as any) ?? null;
  }

  async getByExternalId(orgId: string, externalId: string): Promise<UserRow | null> {
    const r = await this.pool.query(`SELECT * FROM users WHERE org_id = $1 AND external_id = $2`, [orgId, externalId]);
    return (r.rows[0] as any) ?? null;
  }

  async list(opts: UserListOpts): Promise<{ entries: UserRow[]; total: number }> {
    let where = `org_id = $1`;
    const params: any[] = [opts.org_id];
    if (opts.whereExtra) {
      // Re-number any $N placeholders in the fragment so they continue
      // from our base count. We accept that callers pass ?-style or $-style.
      const offset = params.length;
      let renumbered = opts.whereExtra.where;
      // Convert ? to $n in order.
      let i = 0;
      renumbered = renumbered.replace(/\?/g, () => `$${offset + (++i)}`);
      where += ` AND ${renumbered}`;
      params.push(...opts.whereExtra.params);
    }
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit = Math.min(opts.limit ?? 100, 200);
    const offset = opts.offset ?? 0;
    const order = opts.orderBy ?? 'created_at ASC';
    const r = await this.pool.query(
      `SELECT * FROM users WHERE ${where} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as UserRow[], total };
  }

  async update(orgId: string, id: string, patch: Partial<UserInsert>): Promise<void> {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === 'org_id') continue;
      if (!ALLOWED_COLS.has(k)) continue;
      sets.push(`${k} = $${args.length + 1}`);
      args.push(v ?? null);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = NOW()`);
    await this.pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND org_id = $${args.length + 2}`,
      [...args, id, orgId],
    );
  }

  async setColumn(orgId: string, id: string, col: string, value: any): Promise<void> {
    if (!ALLOWED_COLS.has(col)) throw new Error(`setColumn: column not whitelisted: ${col}`);
    await this.pool.query(
      `UPDATE users SET ${col} = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
      [value, id, orgId],
    );
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM users WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
