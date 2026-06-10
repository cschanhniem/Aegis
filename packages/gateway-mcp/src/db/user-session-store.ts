/**
 * UserSessionStore — cockpit bearer-token session store (post-IdP login).
 *
 * Tokens are hashed at rest (sha256). Plaintext only emitted at issue
 * time. Expiry is enforced on every read by filtering on expires_at;
 * a periodic janitor (out of scope of this store — runs in the auth
 * service) sweeps expired rows.
 *
 * NOT the same as `traces`/session correlation (which is a different
 * column on the traces table). This is the cockpit / API auth session.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface UserSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  idp: string | null;
  idp_sub: string | null;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface UserSessionInsert {
  id: string;
  userId: string;
  tokenHash: string;
  idp?: string | null;
  idpSub?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  expiresAt: string;          // ISO timestamp
}

export interface UserSessionStore {
  init(): Promise<void>;
  insert(row: UserSessionInsert): Promise<void>;
  /** Look up a session by token hash. Returns null if revoked or
   *  expired so callers don't need to double-check. */
  findActive(tokenHash: string): Promise<UserSessionRow | null>;
  touch(id: string): Promise<void>;
  revoke(id: string): Promise<boolean>;
  /** Revoke every session for a user (e.g. on password change / forced
   *  logout). Returns the number of rows affected. */
  revokeAllForUser(userId: string): Promise<number>;
  /** Delete expired rows older than the given cutoff. Returns count. */
  purgeExpired(beforeIso: string): Promise<number>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteUserSessionStore implements UserSessionStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        idp TEXT,
        idp_sub TEXT,
        ip_address TEXT,
        user_agent TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token   ON user_sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user    ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
    `);
  }

  async insert(r: UserSessionInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO user_sessions (id, user_id, token_hash, idp, idp_sub, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.userId, r.tokenHash, r.idp ?? null, r.idpSub ?? null,
          r.ipAddress ?? null, r.userAgent ?? null, r.expiresAt);
  }

  async findActive(tokenHash: string): Promise<UserSessionRow | null> {
    // Wrap both sides in `datetime(...)` so lexical comparison ordering
    // doesn't break when callers pass ISO 8601 ("YYYY-MM-DDTHH:..Z") AND
    // we use `datetime('now')` (which emits "YYYY-MM-DD HH:..") — the
    // 'T' character is lexically > the space separator. datetime() on
    // both sides normalises into a canonical comparable form.
    const row = this.db.prepare(
      `SELECT * FROM user_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')`,
    ).get(tokenHash) as any;
    return row ?? null;
  }

  async touch(id: string): Promise<void> {
    this.db.prepare(`UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(id);
  }

  async revoke(id: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE user_sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`,
    ).run(id);
    return r.changes > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const r = this.db.prepare(
      `UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`,
    ).run(userId);
    return r.changes;
  }

  async purgeExpired(beforeIso: string): Promise<number> {
    const r = this.db.prepare(`DELETE FROM user_sessions WHERE expires_at < ?`).run(beforeIso);
    return r.changes;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    idp TEXT,
    idp_sub TEXT,
    ip_address TEXT,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_token   ON user_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_sessions_user    ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
`;

export class PostgresUserSessionStore implements UserSessionStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: UserSessionInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, idp, idp_sub, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.id, r.userId, r.tokenHash, r.idp ?? null, r.idpSub ?? null,
       r.ipAddress ?? null, r.userAgent ?? null, r.expiresAt],
    );
  }

  async findActive(tokenHash: string): Promise<UserSessionRow | null> {
    const r = await this.pool.query(
      `SELECT * FROM user_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [tokenHash],
    );
    return (r.rows[0] as any) ?? null;
  }

  async touch(id: string): Promise<void> {
    await this.pool.query(`UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1`, [id]);
  }

  async revoke(id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const r = await this.pool.query(
      `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return r.rowCount ?? 0;
  }

  async purgeExpired(beforeIso: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM user_sessions WHERE expires_at < $1`, [beforeIso]);
    return r.rowCount ?? 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
