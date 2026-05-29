/**
 * Session service — issues, validates, and revokes Bearer tokens
 * for human users authenticated via an IdP.
 *
 * Coexists with the existing X-API-Key mechanism: service accounts
 * and SDK callers keep using keys; humans logging into the Cockpit
 * use sessions. The auth middleware tries the Bearer header first
 * and falls back to X-API-Key if no Bearer is present.
 *
 * Tokens are stored hashed (sha256). The plaintext is returned to
 * the caller exactly once on issuance; we never echo it back
 * anywhere else (no log, no audit row body), so a stolen DB dump
 * can't be used to impersonate active users.
 */

import { createHash, randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';

export interface SessionRecord {
  id: string;
  user_id: string;
  /** Hash of the bearer token. Never the plaintext. */
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

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  org_id: string;
}

const DEFAULT_TTL_HOURS = 12;

export class SessionService {
  constructor(
    private db: Database.Database,
    private logger?: Logger,
  ) {}

  /** Issue a new session for a user.
   *  Returns { token } — the plaintext, exactly once. */
  issue(opts: {
    user_id: string;
    idp?: string;
    idp_sub?: string;
    ip_address?: string;
    user_agent?: string;
    ttl_hours?: number;
  }): { id: string; token: string; expires_at: string } {
    const id = randomBytes(16).toString('hex');
    // 32 bytes of randomness; base64url so headers can carry it cleanly.
    const token = `aegis_s_${randomBytes(32).toString('base64url')}`;
    const token_hash = sha256(token);
    const ttlHours = Math.max(1, Math.min(opts.ttl_hours ?? DEFAULT_TTL_HOURS, 24 * 30));
    const expires_at = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

    this.db.prepare(
      `INSERT INTO user_sessions
       (id, user_id, token_hash, idp, idp_sub, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.user_id,
      token_hash,
      opts.idp ?? null,
      opts.idp_sub ?? null,
      opts.ip_address ?? null,
      opts.user_agent ?? null,
      expires_at,
    );

    return { id, token, expires_at };
  }

  /** Look up a session by its plaintext bearer token + return the
   *  joined user. Returns null on:
   *    - unknown token
   *    - expired token
   *    - revoked session
   *    - user status != 'active'
   *  Touches last_seen_at on a successful read. */
  resolve(token: string): SessionUser | null {
    if (!token || typeof token !== 'string') return null;
    const tokenHash = sha256(token);
    const row = this.db.prepare(
      `SELECT s.id as session_id, s.expires_at, s.revoked_at,
              u.id as user_id, u.email, u.name, u.role, u.org_id, u.status
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    ).get(tokenHash) as
      | {
          session_id: string;
          expires_at: string;
          revoked_at: string | null;
          user_id: string;
          email: string;
          name: string | null;
          role: string;
          org_id: string;
          status: string;
        }
      | undefined;

    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at) <= new Date()) return null;
    if (row.status !== 'active') return null;

    // Best-effort last-seen update; failure here is non-fatal.
    try {
      this.db.prepare(
        `UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?`,
      ).run(row.session_id);
    } catch { /* keep going */ }

    return {
      id: row.user_id,
      email: row.email,
      name: row.name ?? null,
      role: row.role,
      org_id: row.org_id,
    };
  }

  /** Mark a session revoked. Idempotent — subsequent calls are no-ops. */
  revoke(sessionId: string): void {
    this.db.prepare(
      `UPDATE user_sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`,
    ).run(sessionId);
  }

  /** Sweep expired + revoked sessions older than 7 days. Safe to call
   *  on a cron / periodic timer; deletes nothing under 7 days so a
   *  recently-revoked session is still queryable for support. */
  purgeOld(): { deleted: number } {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = this.db.prepare(
      `DELETE FROM user_sessions
       WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
          OR (expires_at < ?)`,
    ).run(cutoff, cutoff);
    return { deleted: r.changes };
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
