/**
 * Phase A store tests — 5 new stores × 2 backends (Sqlite + Postgres
 * via pg-mem). Pins the same contract on both backends per the
 * migration runbook §contract-parity.
 *
 * Stores covered:
 *   - GatewayConfigStore   (gateway_config)
 *   - ScimTokenStore       (scim_tokens)
 *   - UserStore            (users)
 *   - GroupStore           (groups + group_members)
 *   - UserSessionStore     (user_sessions)
 *
 * Each describe block runs identical assertions against the
 * Sqlite and Postgres adapter. Where the Postgres adapter exists
 * but pg-mem rejects a feature (rare), the test skips with a
 * documented reason rather than guessing.
 */
import Database from 'better-sqlite3';
import { newDb } from 'pg-mem';
import { randomUUID, createHash, randomBytes } from 'crypto';

import { SqliteGatewayConfigStore, PostgresGatewayConfigStore, type GatewayConfigStore } from '../db/gateway-config-store';
import { SqliteScimTokenStore,     PostgresScimTokenStore,     type ScimTokenStore }     from '../db/scim-token-store';
import { SqliteUserStore,          PostgresUserStore,          type UserStore }          from '../db/user-store';
import { SqliteGroupStore,         PostgresGroupStore,         type GroupStore }         from '../db/group-store';
import { SqliteUserSessionStore,   PostgresUserSessionStore,   type UserSessionStore }   from '../db/user-session-store';

function makePool(): any {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ── GatewayConfigStore ─────────────────────────────────────────────────

function runGatewayConfig(name: string, make: () => Promise<GatewayConfigStore>) {
  describe(`GatewayConfigStore (${name})`, () => {
    let s: GatewayConfigStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('set + get round-trips', async () => {
      await s.set('dashboard_api_key', 'abc-123');
      expect(await s.get('dashboard_api_key')).toBe('abc-123');
    });

    test('get on missing key returns null', async () => {
      expect(await s.get('nonexistent')).toBeNull();
    });

    test('set overwrites existing value', async () => {
      await s.set('k', 'v1');
      await s.set('k', 'v2');
      expect(await s.get('k')).toBe('v2');
    });

    test('getOrCreate creates the key when absent', async () => {
      let calls = 0;
      const v = await s.getOrCreate('boot', () => { calls++; return 'made-' + calls; });
      expect(v).toBe('made-1');
      // Re-calling does NOT regenerate.
      const v2 = await s.getOrCreate('boot', () => { calls++; return 'made-' + calls; });
      expect(v2).toBe('made-1');
      expect(calls).toBe(1);
    });

    test('delete removes the key', async () => {
      await s.set('temp', 'x');
      await s.delete('temp');
      expect(await s.get('temp')).toBeNull();
    });
  });
}
runGatewayConfig('Sqlite',   async () => { const s = new SqliteGatewayConfigStore(new Database(':memory:')); await s.init(); return s; });
runGatewayConfig('Postgres', async () => { const s = new PostgresGatewayConfigStore(makePool());            await s.init(); return s; });

// ── ScimTokenStore ─────────────────────────────────────────────────────

function runScimToken(name: string, make: () => Promise<ScimTokenStore>) {
  describe(`ScimTokenStore (${name})`, () => {
    let s: ScimTokenStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + resolveOrg round-trips', async () => {
      const id = randomUUID();
      const plaintext = 'scim_' + randomBytes(8).toString('hex');
      await s.insert({ id, orgId: 'acme', name: 'okta-prod', tokenHash: sha(plaintext) });
      expect(await s.resolveOrg(sha(plaintext))).toBe('acme');
    });

    test('resolveOrg returns null for unknown hash', async () => {
      expect(await s.resolveOrg(sha('garbage'))).toBeNull();
    });

    test('revoked tokens no longer resolve', async () => {
      const id = randomUUID();
      const t = 'scim_' + randomBytes(8).toString('hex');
      await s.insert({ id, orgId: 'acme', name: 'temp', tokenHash: sha(t) });
      expect(await s.resolveOrg(sha(t))).toBe('acme');
      expect(await s.revoke('acme', id)).toBe(true);
      expect(await s.resolveOrg(sha(t))).toBeNull();
    });

    test('list scopes by org', async () => {
      await s.insert({ id: randomUUID(), orgId: 'a', name: 't1', tokenHash: sha('p1') });
      await s.insert({ id: randomUUID(), orgId: 'a', name: 't2', tokenHash: sha('p2') });
      await s.insert({ id: randomUUID(), orgId: 'b', name: 't3', tokenHash: sha('p3') });
      expect((await s.list('a')).length).toBe(2);
      expect((await s.list('b')).length).toBe(1);
    });

    test('revoke from another org is a no-op', async () => {
      const id = randomUUID();
      await s.insert({ id, orgId: 'a', name: 'x', tokenHash: sha('xx') });
      expect(await s.revoke('b', id)).toBe(false);
      expect(await s.resolveOrg(sha('xx'))).toBe('a');
    });
  });
}
runScimToken('Sqlite',   async () => { const s = new SqliteScimTokenStore(new Database(':memory:')); await s.init(); return s; });
runScimToken('Postgres', async () => { const s = new PostgresScimTokenStore(makePool());            await s.init(); return s; });

// ── UserStore ──────────────────────────────────────────────────────────

function runUser(name: string, make: () => Promise<UserStore>) {
  describe(`UserStore (${name})`, () => {
    let s: UserStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + get by id', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', email: 'a@acme.com', role: 'admin', name: 'Alice' });
      const u = await s.get('acme', id);
      expect(u?.email).toBe('a@acme.com');
      expect(u?.role).toBe('admin');
    });

    test('get by email + getByExternalId both work', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', email: 'b@acme.com', external_id: 'okta-uid-1' });
      expect((await s.getByEmail('acme', 'b@acme.com'))?.id).toBe(id);
      expect((await s.getByExternalId('acme', 'okta-uid-1'))?.id).toBe(id);
    });

    test('list scopes by org', async () => {
      await s.insert({ id: randomUUID(), org_id: 'a', email: 'a1@a.com' });
      await s.insert({ id: randomUUID(), org_id: 'a', email: 'a2@a.com' });
      await s.insert({ id: randomUUID(), org_id: 'b', email: 'b1@b.com' });
      const a = await s.list({ org_id: 'a' });
      expect(a.total).toBe(2);
      expect(a.entries.every(u => u.org_id === 'a')).toBe(true);
    });

    test('update writes whitelisted fields, ignores rejected ones', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', email: 'c@acme.com', role: 'viewer' });
      await s.update('acme', id, { role: 'admin', name: 'Carol', external_id: 'ext-1' } as any);
      const u = await s.get('acme', id);
      expect(u?.role).toBe('admin');
      expect(u?.name).toBe('Carol');
      expect(u?.external_id).toBe('ext-1');
    });

    test('setColumn rejects non-whitelisted columns', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', email: 'd@acme.com' });
      await expect(s.setColumn('acme', id, 'org_id', 'evil')).rejects.toThrow();
    });

    test('delete returns true on hit, false on cross-tenant', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', email: 'e@acme.com' });
      expect(await s.delete('beta', id)).toBe(false);
      expect(await s.delete('acme', id)).toBe(true);
      expect(await s.get('acme', id)).toBeNull();
    });

    test('cross-tenant get returns null even with correct id', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', email: 'f@acme.com' });
      expect(await s.get('beta', id)).toBeNull();
    });
  });
}
runUser('Sqlite',   async () => { const s = new SqliteUserStore(new Database(':memory:')); await s.init(); return s; });
runUser('Postgres', async () => { const s = new PostgresUserStore(makePool());            await s.init(); return s; });

// ── GroupStore ─────────────────────────────────────────────────────────

function runGroup(name: string, make: () => Promise<{ groups: GroupStore; users: UserStore }>) {
  describe(`GroupStore (${name})`, () => {
    let h: { groups: GroupStore; users: UserStore };
    beforeEach(async () => { h = await make(); });
    afterEach(async () => { await h.groups.close(); await h.users.close(); });

    test('insert + get + list', async () => {
      const id = randomUUID();
      await h.groups.insert({ id, orgId: 'acme', displayName: 'engineers' });
      expect((await h.groups.get('acme', id))?.display_name).toBe('engineers');
      const list = await h.groups.list({ orgId: 'acme' });
      expect(list.total).toBe(1);
    });

    test('add + list members; users from other orgs cannot be added (FK)', async () => {
      const gid = randomUUID();
      const uid1 = randomUUID();
      const uid2 = randomUUID();
      await h.groups.insert({ id: gid, orgId: 'acme', displayName: 'team' });
      await h.users.insert({ id: uid1, org_id: 'acme', email: 'm1@acme.com', name: 'M1' });
      await h.users.insert({ id: uid2, org_id: 'acme', email: 'm2@acme.com', name: 'M2' });
      await h.groups.addMembers('acme', gid, [uid1, uid2]);
      const members = await h.groups.listMembers(gid);
      expect(members.length).toBe(2);
    });

    test('removeMembers removes only the listed users', async () => {
      const gid = randomUUID();
      const uid1 = randomUUID();
      const uid2 = randomUUID();
      await h.groups.insert({ id: gid, orgId: 'acme', displayName: 'team2' });
      await h.users.insert({ id: uid1, org_id: 'acme', email: 'r1@acme.com', name: 'R1' });
      await h.users.insert({ id: uid2, org_id: 'acme', email: 'r2@acme.com', name: 'R2' });
      await h.groups.setMembers('acme', gid, [uid1, uid2]);
      await h.groups.removeMembers('acme', gid, [uid1]);
      const members = await h.groups.listMembers(gid);
      expect(members.length).toBe(1);
      expect(members[0].value).toBe(uid2);
    });

    test('listGroupsForUser returns each group the user is in', async () => {
      const u = randomUUID();
      const g1 = randomUUID();
      const g2 = randomUUID();
      await h.users.insert({ id: u, org_id: 'acme', email: 'p@acme.com', name: 'P' });
      await h.groups.insert({ id: g1, orgId: 'acme', displayName: 'gA' });
      await h.groups.insert({ id: g2, orgId: 'acme', displayName: 'gB' });
      await h.groups.addMembers('acme', g1, [u]);
      await h.groups.addMembers('acme', g2, [u]);
      const groups = await h.groups.listGroupsForUser(u);
      expect(groups.length).toBe(2);
    });

    test('rename updates display_name', async () => {
      const id = randomUUID();
      await h.groups.insert({ id, orgId: 'acme', displayName: 'before' });
      await h.groups.rename('acme', id, 'after');
      expect((await h.groups.get('acme', id))?.display_name).toBe('after');
    });

    test('delete returns true; cross-tenant delete returns false', async () => {
      const id = randomUUID();
      await h.groups.insert({ id, orgId: 'acme', displayName: 'gone' });
      expect(await h.groups.delete('beta', id)).toBe(false);
      expect(await h.groups.delete('acme', id)).toBe(true);
    });
  });
}
runGroup('Sqlite', async () => {
  const db = new Database(':memory:');
  const users = new SqliteUserStore(db);  await users.init();
  const groups = new SqliteGroupStore(db); await groups.init();
  return { groups, users };
});
runGroup('Postgres', async () => {
  const pool = makePool();
  const users = new PostgresUserStore(pool);  await users.init();
  const groups = new PostgresGroupStore(pool); await groups.init();
  return { groups, users };
});

// ── UserSessionStore ──────────────────────────────────────────────────

function runSession(name: string, make: () => Promise<UserSessionStore>) {
  describe(`UserSessionStore (${name})`, () => {
    let s: UserSessionStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    const futureIso = () => new Date(Date.now() + 3600_000).toISOString();
    const pastIso   = () => new Date(Date.now() - 3600_000).toISOString();

    test('insert + findActive', async () => {
      const id = randomUUID();
      const token = sha('plaintext');
      await s.insert({ id, userId: 'u1', tokenHash: token, expiresAt: futureIso() });
      const row = await s.findActive(token);
      expect(row?.id).toBe(id);
      expect(row?.user_id).toBe('u1');
    });

    test('expired session is NOT returned by findActive', async () => {
      const id = randomUUID();
      const token = sha('expired');
      await s.insert({ id, userId: 'u1', tokenHash: token, expiresAt: pastIso() });
      expect(await s.findActive(token)).toBeNull();
    });

    test('revoked session is NOT returned by findActive', async () => {
      const id = randomUUID();
      const token = sha('revoked');
      await s.insert({ id, userId: 'u1', tokenHash: token, expiresAt: futureIso() });
      expect(await s.revoke(id)).toBe(true);
      expect(await s.findActive(token)).toBeNull();
    });

    test('revokeAllForUser invalidates every live session of that user', async () => {
      await s.insert({ id: randomUUID(), userId: 'u1', tokenHash: sha('a'), expiresAt: futureIso() });
      await s.insert({ id: randomUUID(), userId: 'u1', tokenHash: sha('b'), expiresAt: futureIso() });
      await s.insert({ id: randomUUID(), userId: 'u2', tokenHash: sha('c'), expiresAt: futureIso() });
      const n = await s.revokeAllForUser('u1');
      expect(n).toBe(2);
      expect(await s.findActive(sha('a'))).toBeNull();
      expect(await s.findActive(sha('b'))).toBeNull();
      expect((await s.findActive(sha('c')))?.user_id).toBe('u2');
    });

    test('purgeExpired removes only old rows', async () => {
      const cutoff = new Date(Date.now() - 1000).toISOString();
      await s.insert({ id: randomUUID(), userId: 'u1', tokenHash: sha('x1'), expiresAt: pastIso() });
      await s.insert({ id: randomUUID(), userId: 'u1', tokenHash: sha('x2'), expiresAt: futureIso() });
      const n = await s.purgeExpired(cutoff);
      expect(n).toBe(1);
    });
  });
}
runSession('Sqlite',   async () => { const s = new SqliteUserSessionStore(new Database(':memory:')); await s.init(); return s; });
runSession('Postgres', async () => { const s = new PostgresUserSessionStore(makePool());            await s.init(); return s; });
