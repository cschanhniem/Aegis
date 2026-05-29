/**
 * Session service — tests the lifecycle: issue → resolve → revoke +
 * the expiry + status-gating + purge sweep.
 */
import pino from 'pino';
import Database from 'better-sqlite3';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { SessionService } from '../services/session';

const silent = pino({ level: 'silent' });

function makeStack() {
  const db = new Database(':memory:');
  initializeEnterpriseSchema(db);
  // Seed an active user we can issue sessions to.
  db.prepare(
    `INSERT INTO users (id, org_id, email, name, role, status)
     VALUES (?, 'default', ?, ?, 'admin', 'active')`,
  ).run('u-alice', 'alice@example.com', 'Alice');
  return { db, svc: new SessionService(db, silent) };
}

describe('SessionService', () => {
  test('issue returns plaintext token + persisted record; resolve returns the user', () => {
    const { svc } = makeStack();
    const { id, token, expires_at } = svc.issue({ user_id: 'u-alice', idp: 'mock' });
    expect(token.startsWith('aegis_s_')).toBe(true);
    expect(typeof id).toBe('string');
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());

    const user = svc.resolve(token);
    expect(user).not.toBeNull();
    expect(user?.email).toBe('alice@example.com');
    expect(user?.role).toBe('admin');
    expect(user?.org_id).toBe('default');
  });

  test('resolve returns null for unknown / blank tokens', () => {
    const { svc } = makeStack();
    expect(svc.resolve('not-a-token')).toBeNull();
    expect(svc.resolve('')).toBeNull();
    expect(svc.resolve(null as any)).toBeNull();
  });

  test('resolve returns null after revoke', () => {
    const { svc } = makeStack();
    const { id, token } = svc.issue({ user_id: 'u-alice' });
    expect(svc.resolve(token)).not.toBeNull();
    svc.revoke(id);
    expect(svc.resolve(token)).toBeNull();
    // Idempotent
    svc.revoke(id);
    expect(svc.resolve(token)).toBeNull();
  });

  test('resolve returns null when user status flips away from active', () => {
    const { db, svc } = makeStack();
    const { token } = svc.issue({ user_id: 'u-alice' });
    expect(svc.resolve(token)).not.toBeNull();
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = 'u-alice'`).run();
    expect(svc.resolve(token)).toBeNull();
  });

  test('resolve returns null on an expired session', () => {
    const { db, svc } = makeStack();
    const { id, token } = svc.issue({ user_id: 'u-alice' });
    // Age the row with an explicit ISO-Z timestamp so the resolve
    // comparison (which uses `new Date(expires_at)`) parses it as
    // UTC instead of local time.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE user_sessions SET expires_at = ? WHERE id = ?`,
    ).run(oneHourAgo, id);
    expect(svc.resolve(token)).toBeNull();
  });

  test('ttl_hours param is honoured + clamped to [1, 720]', () => {
    const { db, svc } = makeStack();
    const a = svc.issue({ user_id: 'u-alice', ttl_hours: 1 });
    const b = svc.issue({ user_id: 'u-alice', ttl_hours: 99999 });
    const c = svc.issue({ user_id: 'u-alice', ttl_hours: 0 });
    const rows = db.prepare(
      `SELECT id, expires_at FROM user_sessions WHERE id IN (?, ?, ?)`,
    ).all(a.id, b.id, c.id) as { id: string; expires_at: string }[];
    const byId = Object.fromEntries(rows.map(r => [r.id, new Date(r.expires_at).getTime()]));
    const now = Date.now();
    expect(byId[a.id] - now).toBeLessThan(2 * 60 * 60 * 1000); // ~1h
    expect(byId[b.id] - now).toBeLessThan(31 * 24 * 60 * 60 * 1000); // cap 30d
    expect(byId[c.id] - now).toBeGreaterThan(0); // floor 1h applied
  });

  test('purgeOld deletes expired/revoked sessions older than 7d; spares fresh ones', () => {
    const { db, svc } = makeStack();
    const fresh = svc.issue({ user_id: 'u-alice' });
    // Age out one revoked + one expired.
    const old1 = svc.issue({ user_id: 'u-alice' });
    db.prepare(`UPDATE user_sessions SET revoked_at = datetime('now', '-30 day') WHERE id = ?`).run(old1.id);
    const old2 = svc.issue({ user_id: 'u-alice' });
    db.prepare(`UPDATE user_sessions SET expires_at = datetime('now', '-30 day') WHERE id = ?`).run(old2.id);

    const r = svc.purgeOld();
    expect(r.deleted).toBeGreaterThanOrEqual(2);
    // Fresh session should still resolve.
    expect(svc.resolve(fresh.token)).not.toBeNull();
  });

  test('token is stored hashed — plaintext never appears in the row', () => {
    const { db, svc } = makeStack();
    const { token } = svc.issue({ user_id: 'u-alice' });
    const row = db.prepare(`SELECT token_hash FROM user_sessions LIMIT 1`).get() as { token_hash: string };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash.length).toBe(64); // sha256 hex
  });
});
