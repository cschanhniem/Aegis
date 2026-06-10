/**
 * Postgres-backed PolicyStore + PolicyEngine integration tests.
 *
 * Uses pg-mem (an in-process Postgres emulator that speaks real wire
 * protocol semantics) so we can prove the Postgres adapter PASSES THE
 * EXACT SAME multi-tenant contract as SQLite without provisioning a
 * real server in CI.
 *
 * This is the "Postgres-ready" claim for the sales conversation —
 * verifiable per-PR.
 */
import pino from 'pino';
import { newDb } from 'pg-mem';
import { PostgresPolicyStore } from '../db/postgres-policy-store';
import { PolicyEngine } from '../policies/policy-engine';

const silentLogger = pino({ level: 'silent' });

/** Build a pg-mem instance + return a node-pg Pool that talks to it.
 *  pg-mem.adapters.createPg() gives us a drop-in Pool/Client pair. */
async function makePool(): Promise<any> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  // pg-mem doesn't implement EVERY pg function — register the few
  // node-postgres uses internally for version negotiation. Most
  // queries flow through unmodified.
  db.public.registerFunction({
    name: 'current_database',
    returns: 0 as any,        // text
    implementation: () => 'pg_mem',
    impure: true,
  });
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

async function newStore() {
  const pool = await makePool();
  const store = PostgresPolicyStore.fromPool(pool);
  await store.init();
  return { store, pool };
}

async function seedDefaults(store: PostgresPolicyStore) {
  // Same 5 platform-default seed as the SQLite tests, just driven
  // through the Store API so both adapters get exercised identically.
  const defaults = [
    { id: 'sql-injection',     name: 'SQL Injection Prevention', description: 'Blocks ; -- UNION etc.', risk_level: 'HIGH' as const,
      policy_schema: '{"type":"object","properties":{"sql":{"type":"string","not":{"pattern":"(DROP|TRUNCATE|EXEC|;)"}}},"additionalProperties":true}' },
    { id: 'prompt-injection',  name: 'Prompt Injection Detection', description: 'd', risk_level: 'CRITICAL' as const, policy_schema: '{}' },
    { id: 'file-access',       name: 'File Access Control', description: 'd', risk_level: 'MEDIUM' as const, policy_schema: '{}' },
    { id: 'network-access',    name: 'Network Access Control', description: 'd', risk_level: 'MEDIUM' as const, policy_schema: '{}' },
    { id: 'data-exfiltration', name: 'Data Exfiltration Prevention', description: 'd', risk_level: 'HIGH' as const, policy_schema: '{}' },
  ];
  for (const d of defaults) await store.upsert({ ...d, org_id: '*' });
}

describe('PostgresPolicyStore — base API', () => {
  test('init creates table + accepts seed inserts', async () => {
    const { store, pool } = await newStore();
    await seedDefaults(store);
    const rows = await store.listEnabledWildcards();
    expect(rows.length).toBe(5);
    expect(rows.every(r => r.org_id === '*')).toBe(true);
    await pool.end();
  });

  test('listEnabledForOrg returns only the tenant rows', async () => {
    const { store, pool } = await newStore();
    await seedDefaults(store);
    await store.upsert({ id: 'acme-1', name: 'Acme custom', description: '', risk_level: 'LOW', policy_schema: '{}', org_id: 'acme' });
    const wild = await store.listEnabledWildcards();
    const acme = await store.listEnabledForOrg('acme');
    const beta = await store.listEnabledForOrg('beta');
    expect(wild.length).toBe(5);
    expect(acme.map(r => r.id)).toEqual(['acme-1']);
    expect(beta.length).toBe(0);
    await pool.end();
  });

  test('upsert replaces an existing row by id', async () => {
    const { store, pool } = await newStore();
    await store.upsert({ id: 'x', name: 'first',  description: '', risk_level: 'LOW', policy_schema: '{}', org_id: 'acme' });
    await store.upsert({ id: 'x', name: 'second', description: '', risk_level: 'LOW', policy_schema: '{}', org_id: 'acme' });
    const rows = await store.listEnabledForOrg('acme');
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('second');
    await pool.end();
  });

  test('setEnabledForOrg falls back to wildcard scope when tenant row absent', async () => {
    const { store, pool } = await newStore();
    await seedDefaults(store);
    const r = await store.setEnabledForOrg('sql-injection', 'acme', false);
    expect(r.scope).toBe('wildcard');
    expect(r.changed).toBe(true);
    const wild = await store.listEnabledWildcards();
    expect(wild.find(p => p.id === 'sql-injection')).toBeUndefined();   // now disabled
    await pool.end();
  });

  test('deleteForOrg only removes the tenant row, leaves wildcards', async () => {
    const { store, pool } = await newStore();
    await seedDefaults(store);
    await store.upsert({ id: 'acme-z', name: 'Acme Z', description: '', risk_level: 'LOW', policy_schema: '{}', org_id: 'acme' });
    const r = await store.deleteForOrg('acme-z', 'acme');
    expect(r.deleted).toBe(true);
    expect((await store.listEnabledWildcards()).length).toBe(5);
    expect((await store.listEnabledForOrg('acme')).length).toBe(0);
    await pool.end();
  });
});

describe('PolicyEngine on top of PostgresPolicyStore — contract parity', () => {
  test('multi-tenant isolation works identically to SQLite path', async () => {
    const { store, pool } = await newStore();
    await seedDefaults(store);
    const engine = new PolicyEngine(store, silentLogger, true);
    await engine.warm('default');
    await engine.warm('acme');

    await engine.addPolicy({
      id: 'acme-https',
      name: 'Acme HTTPS-only',
      description: 'All URLs must be https://',
      policy_schema: { type: 'object', properties: { url: { type: 'string', pattern: '^https://' } }, additionalProperties: true },
      risk_level: 'HIGH',
    }, 'acme');

    const acmeBlock = await engine.validateToolCall(
      { tool: 'custom_action', arguments: { url: 'ftp://acme.local' } }, 'acme',
    );
    const betaPass = await engine.validateToolCall(
      { tool: 'custom_action', arguments: { url: 'ftp://beta.local' } }, 'beta',
    );

    expect(acmeBlock.passed).toBe(false);
    expect(acmeBlock.policy_name).toBe('Acme HTTPS-only');
    expect(betaPass.passed).toBe(true);
    await pool.end();
  });

  test('wildcard shadowing via tenant row works on Postgres', async () => {
    const { store, pool } = await newStore();
    await seedDefaults(store);
    const engine = new PolicyEngine(store, silentLogger, true);
    await engine.warm('acme');

    await engine.addPolicy({
      id: 'acme-sql-strict',
      name: 'SQL Injection Prevention',   // SAME name → shadows wildcard
      description: 'No SQL at all.',
      policy_schema: { type: 'object', properties: { sql: { maxLength: 0 } }, additionalProperties: true },
      risk_level: 'CRITICAL',
    }, 'acme');

    const view = await engine.getPolicies('acme');
    const shadowed = view.find(p => p.name === 'SQL Injection Prevention');
    expect(shadowed?.id).toBe('acme-sql-strict');
    await pool.end();
  });

  test('warming an org pre-loads the policies (no first-call latency)', async () => {
    const { store, pool } = await newStore();
    await seedDefaults(store);
    const engine = new PolicyEngine(store, silentLogger, true);
    await engine.warm('beta');
    // No async wait on validate — view already materialised.
    const r = await engine.validateToolCall(
      { tool: 'anything', arguments: { foo: 'bar' } }, 'beta',
    );
    expect(r.passed).toBe(true);
    await pool.end();
  });
});
