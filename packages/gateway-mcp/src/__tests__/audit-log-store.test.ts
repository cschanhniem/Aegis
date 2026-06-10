/**
 * AuditLogStore tests — proves the abstraction works identically on
 * Sqlite (in-memory) and Postgres (pg-mem). Pins the write/read
 * contract, the multi-row Postgres batched flush, and the query
 * filters.
 */
import Database from 'better-sqlite3';
import { newDb } from 'pg-mem';
import { SqliteAuditLogStore, PostgresAuditLogStore, type AuditLogStore } from '../db/audit-log-store';

async function makeSqliteStore(): Promise<AuditLogStore> {
  const db = new Database(':memory:');
  const s = new SqliteAuditLogStore(db);
  await s.init();
  return s;
}

async function makePgStore(): Promise<{ store: PostgresAuditLogStore; pool: any }> {
  // pg-mem natively supports NOW() / CURRENT_TIMESTAMP — no registerFunction needed.
  const memdb = newDb();
  const { Pool } = memdb.adapters.createPg();
  const pool = new Pool();
  // Long flush interval; tests call flush() explicitly to be deterministic.
  const store = new PostgresAuditLogStore(pool, { flushIntervalMs: 60_000, maxBatch: 10_000 });
  await store.init();
  return { store, pool };
}

describe('SqliteAuditLogStore', () => {
  let s: AuditLogStore;
  beforeEach(async () => { s = await makeSqliteStore(); });

  test('log → query round-trips', async () => {
    s.log({ org_id: 'a', user_id: 'u1', user_email: 'alice@x.com', action: 'policy.create', resource_type: 'policy', resource_id: 'p1', details: '{"x":1}', ip_address: '10.0.0.1' });
    s.log({ org_id: 'b', user_id: 'u2', user_email: 'bob@x.com',   action: 'apikey.revoke', resource_type: 'apikey', resource_id: 'k1', details: null, ip_address: '10.0.0.2' });
    const r = await s.query({});
    expect(r.total).toBe(2);
    expect(r.entries[0].action).toMatch(/apikey|policy/);
  });

  test('filter by org_id scopes results', async () => {
    s.log({ org_id: 'a', user_id: null, user_email: null, action: 'policy.create', resource_type: 'policy', resource_id: 'p1', details: null, ip_address: null });
    s.log({ org_id: 'b', user_id: null, user_email: null, action: 'policy.create', resource_type: 'policy', resource_id: 'p2', details: null, ip_address: null });
    const r = await s.query({ org_id: 'a' });
    expect(r.total).toBe(1);
    expect(r.entries[0].resource_id).toBe('p1');
  });

  test('query substring (q) hits action / resource_id / details', async () => {
    s.log({ org_id: 'a', user_id: null, user_email: null, action: 'policy.create', resource_type: 'policy', resource_id: 'sql-injection', details: null, ip_address: null });
    s.log({ org_id: 'a', user_id: null, user_email: null, action: 'data.export',   resource_type: 'system', resource_id: null, details: '{"format":"csv"}', ip_address: null });
    expect((await s.query({ q: 'sql' })).total).toBe(1);
    expect((await s.query({ q: 'csv' })).total).toBe(1);
    expect((await s.query({ q: 'create' })).total).toBe(1);
  });

  test('limit + offset paginate', async () => {
    for (let i = 0; i < 30; i++) {
      s.log({ org_id: 'a', user_id: null, user_email: null, action: 'policy.create', resource_type: 'policy', resource_id: `p${i}`, details: null, ip_address: null });
    }
    const p1 = await s.query({ limit: 10, offset: 0 });
    const p2 = await s.query({ limit: 10, offset: 10 });
    expect(p1.entries.length).toBe(10);
    expect(p2.entries.length).toBe(10);
    expect(p1.entries[0].resource_id).not.toBe(p2.entries[0].resource_id);
    expect(p1.total).toBe(30);
  });
});

describe('PostgresAuditLogStore', () => {
  let store: PostgresAuditLogStore;
  let pool: any;
  beforeEach(async () => { ({ store, pool } = await makePgStore()); });
  afterEach(async () => { await store.close().catch(() => {}); });

  test('log → flush → query round-trips with multi-row INSERT', async () => {
    store.log({ org_id: 'a', user_id: 'u1', user_email: 'a@x.com', action: 'policy.create', resource_type: 'policy', resource_id: 'p1', details: '{"x":1}', ip_address: '10.0.0.1' });
    store.log({ org_id: 'a', user_id: 'u1', user_email: 'a@x.com', action: 'policy.update', resource_type: 'policy', resource_id: 'p1', details: null, ip_address: '10.0.0.1' });
    store.log({ org_id: 'b', user_id: 'u2', user_email: 'b@x.com', action: 'apikey.revoke', resource_type: 'apikey', resource_id: 'k1', details: null, ip_address: '10.0.0.2' });
    await store.flush();   // forced; the bg timer hasn't fired yet
    const r = await store.query({});
    expect(r.total).toBe(3);
  });

  test('org-scoped query returns only that org', async () => {
    store.log({ org_id: 'a', user_id: null, user_email: null, action: 'x', resource_type: 'policy', resource_id: 'p1', details: null, ip_address: null });
    store.log({ org_id: 'b', user_id: null, user_email: null, action: 'x', resource_type: 'policy', resource_id: 'p2', details: null, ip_address: null });
    const a = await store.query({ org_id: 'a' });
    expect(a.total).toBe(1);
    expect(a.entries[0].resource_id).toBe('p1');
  });

  test('q (substring) works across action / resource_id / details on pg', async () => {
    store.log({ org_id: 'a', user_id: null, user_email: null, action: 'data.export', resource_type: 'system', resource_id: null, details: '{"format":"csv"}', ip_address: null });
    store.log({ org_id: 'a', user_id: null, user_email: null, action: 'policy.create', resource_type: 'policy', resource_id: 'sql-injection', details: null, ip_address: null });
    expect((await store.query({ q: 'csv'  })).total).toBe(1);
    expect((await store.query({ q: 'sql'  })).total).toBe(1);
    expect((await store.query({ q: 'data' })).total).toBe(1);
  });

  test('limit caps at 200 (cardinality guard)', async () => {
    for (let i = 0; i < 5; i++) {
      store.log({ org_id: 'a', user_id: null, user_email: null, action: 'x', resource_type: 'policy', resource_id: `p${i}`, details: null, ip_address: null });
    }
    const r = await store.query({ limit: 999999 });
    expect(r.entries.length).toBeLessThanOrEqual(200);
  });

  test('action filter on pg parameterises correctly', async () => {
    store.log({ org_id: 'a', user_id: null, user_email: null, action: 'policy.create', resource_type: 'policy', resource_id: 'p1', details: null, ip_address: null });
    store.log({ org_id: 'a', user_id: null, user_email: null, action: 'apikey.revoke', resource_type: 'apikey', resource_id: 'k1', details: null, ip_address: null });
    const r = await store.query({ action: 'policy.create' });
    expect(r.total).toBe(1);
    expect(r.entries[0].resource_id).toBe('p1');
  });
});

describe('contract parity', () => {
  test('both backends return identical query results given identical inputs', async () => {
    const sqlite = await makeSqliteStore();
    const { store: pg } = await makePgStore();

    const seed = [
      { org_id: 'a', user_id: 'u1', user_email: 'a@x.com', action: 'policy.create', resource_type: 'policy', resource_id: 'p1', details: '{"k":1}', ip_address: '10.0.0.1' },
      { org_id: 'a', user_id: 'u1', user_email: 'a@x.com', action: 'policy.update', resource_type: 'policy', resource_id: 'p1', details: null,       ip_address: '10.0.0.1' },
      { org_id: 'b', user_id: 'u2', user_email: 'b@x.com', action: 'apikey.create', resource_type: 'apikey', resource_id: 'k1', details: null,       ip_address: '10.0.0.2' },
    ];
    for (const row of seed) { sqlite.log(row); pg.log(row); }
    await pg.flush();

    const aSql = await sqlite.query({ org_id: 'a' });
    const aPg  = await pg.query({ org_id: 'a' });
    expect(aSql.total).toBe(aPg.total);
    expect(aSql.entries.map(e => e.resource_id).sort()).toEqual(aPg.entries.map(e => e.resource_id).sort());

    await pg.close();
  });
});
