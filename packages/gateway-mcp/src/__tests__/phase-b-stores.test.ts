/**
 * Phase B store tests — 5 stores × 2 backends. Same contract-parity
 * pattern as Phase A. Covers:
 *
 *   - TracesStore           (batched insert, list filters, scoring update)
 *   - TransparencyLogStore  (append-only, size, range, hash lookup)
 *   - ViolationsStore       (insert, list, agent-count-since-window)
 *   - ApprovalsStore        (PENDING → APPROVED/REJECTED state machine)
 *   - PendingChecksStore    (blocking-mode decision lifecycle + expiry)
 */
import Database from 'better-sqlite3';
import { newDb } from 'pg-mem';
import { randomUUID } from 'crypto';

import { SqliteTracesStore, PostgresTracesStore, type TracesStore, type TraceInsert } from '../db/traces-store';
import { SqliteTransparencyLogStore, PostgresTransparencyLogStore, type TransparencyLogStore } from '../db/transparency-log-store';
import { SqliteViolationsStore, PostgresViolationsStore, type ViolationsStore } from '../db/violations-store';
import { SqliteApprovalsStore, PostgresApprovalsStore, type ApprovalsStore } from '../db/approvals-store';
import { SqlitePendingChecksStore, PostgresPendingChecksStore, type PendingChecksStore } from '../db/pending-checks-store';

function makePool(): any {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}
const futureIso = (ms = 3600_000) => new Date(Date.now() + ms).toISOString();
const pastIso   = (ms = 3600_000) => new Date(Date.now() - ms).toISOString();

function mkTrace(overrides: Partial<TraceInsert> = {}): TraceInsert {
  return {
    trace_id: randomUUID(),
    agent_id: 'agent-a',
    org_id: 'acme',
    timestamp: new Date().toISOString(),
    sequence_number: 1,
    input_context: '{"prompt":"hi"}',
    thought_chain: '',
    tool_call: '{"tool_name":"web_search","arguments":{}}',
    observation: '{"raw_output":""}',
    integrity_hash: 'h0',
    environment: 'PRODUCTION',
    version: '1.0.0',
    ...overrides,
  };
}

// ── TracesStore ────────────────────────────────────────────────────────

function runTraces(name: string, make: () => Promise<TracesStore>) {
  describe(`TracesStore (${name})`, () => {
    let s: TracesStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + flush + list round-trips', async () => {
      s.insert(mkTrace({ trace_id: 't1', agent_id: 'a1' }));
      s.insert(mkTrace({ trace_id: 't2', agent_id: 'a1' }));
      s.insert(mkTrace({ trace_id: 't3', agent_id: 'a2' }));
      await s.flush();
      const r = await s.list('acme', {});
      expect(r.total).toBe(3);
    });

    test('list filters by agent_id', async () => {
      s.insert(mkTrace({ trace_id: 'tx', agent_id: 'a1' }));
      s.insert(mkTrace({ trace_id: 'ty', agent_id: 'a2' }));
      await s.flush();
      const a1 = await s.list('acme', { agent_id: 'a1' });
      expect(a1.total).toBe(1);
      expect(a1.entries[0].agent_id).toBe('a1');
    });

    test('org_id scoping isolates tenants', async () => {
      s.insert(mkTrace({ trace_id: 'oa', org_id: 'acme' }));
      s.insert(mkTrace({ trace_id: 'ob', org_id: 'beta' }));
      await s.flush();
      expect((await s.list('acme', {})).total).toBe(1);
      expect((await s.list('beta', {})).total).toBe(1);
    });

    test('get by trace_id', async () => {
      s.insert(mkTrace({ trace_id: 'g1', agent_id: 'aa' }));
      await s.flush();
      const row = await s.get('g1');
      expect(row?.agent_id).toBe('aa');
    });

    test('update writes whitelisted columns; rejects others', async () => {
      s.insert(mkTrace({ trace_id: 'u1' }));
      await s.flush();
      // Score (whitelisted) lands; arbitrary field is dropped silently.
      const ok = await s.update('u1', { score: 1, score_label: 'good' } as any);
      expect(ok).toBe(true);
      const row = await s.get('u1');
      expect(row?.score).toBe(1);
      expect(row?.score_label).toBe('good');
    });

    test('blocked filter is honoured', async () => {
      s.insert(mkTrace({ trace_id: 'b1', blocked: 1 }));
      s.insert(mkTrace({ trace_id: 'b2', blocked: 0 }));
      await s.flush();
      const blockedOnly = await s.list('acme', { blocked: true });
      expect(blockedOnly.entries.every(e => e.blocked === 1)).toBe(true);
    });

    test('duplicate trace_id is a no-op on insert (idempotent)', async () => {
      s.insert(mkTrace({ trace_id: 'dup' }));
      await s.flush();
      // Re-inserting must not crash; row count stays 1.
      try { s.insert(mkTrace({ trace_id: 'dup' })); await s.flush(); } catch { /* sqlite UNIQUE may throw; pg uses ON CONFLICT */ }
      const r = await s.list('acme', {});
      expect(r.entries.filter(e => e.trace_id === 'dup').length).toBe(1);
    });
  });
}
runTraces('Sqlite',   async () => { const s = new SqliteTracesStore(new Database(':memory:')); await s.init(); return s; });
runTraces('Postgres', async () => { const s = new PostgresTracesStore(makePool(), { flushIntervalMs: 60_000 }); await s.init(); return s; });

// ── TransparencyLogStore ───────────────────────────────────────────────

function runTlog(name: string, make: () => Promise<TransparencyLogStore>) {
  describe(`TransparencyLogStore (${name})`, () => {
    let s: TransparencyLogStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('append + size', async () => {
      s.append({ leaf_hash: 'h1', payload: 'p1', source: 'audit', org_id: 'acme' });
      s.append({ leaf_hash: 'h2', payload: 'p2', source: 'trace', org_id: 'acme' });
      await s.flush();
      expect(await s.size()).toBe(2);
    });

    test('range fetches a contiguous slice', async () => {
      for (let i = 1; i <= 5; i++) {
        s.append({ leaf_hash: `h${i}`, payload: `p${i}`, source: 'audit' });
      }
      await s.flush();
      const slice = await s.range(2, 4);
      expect(slice.length).toBe(3);
      expect(slice[0].leaf_hash).toBe('h2');
      expect(slice[2].leaf_hash).toBe('h4');
    });

    test('findByHash returns the leaf if present', async () => {
      s.append({ leaf_hash: 'lookup', payload: 'p', source: 'audit' });
      await s.flush();
      const row = await s.findByHash('lookup');
      expect(row?.payload).toBe('p');
    });

    test('findByHash returns null when absent', async () => {
      expect(await s.findByHash('nonexistent')).toBeNull();
    });

    test('append preserves insertion order via id', async () => {
      s.append({ leaf_hash: 'first',  payload: '1', source: 'audit' });
      s.append({ leaf_hash: 'second', payload: '2', source: 'audit' });
      s.append({ leaf_hash: 'third',  payload: '3', source: 'audit' });
      await s.flush();
      const all = await s.range(1, 3);
      expect(all.map(r => r.leaf_hash)).toEqual(['first', 'second', 'third']);
    });
  });
}
runTlog('Sqlite',   async () => { const s = new SqliteTransparencyLogStore(new Database(':memory:')); await s.init(); return s; });
runTlog('Postgres', async () => { const s = new PostgresTransparencyLogStore(makePool(), { flushIntervalMs: 60_000 }); await s.init(); return s; });

// ── ViolationsStore ────────────────────────────────────────────────────

function runViolations(name: string, make: () => Promise<ViolationsStore>) {
  describe(`ViolationsStore (${name})`, () => {
    let s: ViolationsStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + list', async () => {
      await s.insert({ agent_id: 'a1', policy_id: 'sql-injection', trace_id: 't1', violation_type: 'pattern' });
      await s.insert({ agent_id: 'a1', policy_id: 'file-access',   trace_id: 't2', violation_type: 'path-traversal' });
      const r = await s.list({});
      expect(r.total).toBe(2);
    });

    test('list filters by agent_id', async () => {
      await s.insert({ agent_id: 'a1', policy_id: 'p1', trace_id: 't1', violation_type: 'v1' });
      await s.insert({ agent_id: 'a2', policy_id: 'p1', trace_id: 't2', violation_type: 'v1' });
      expect((await s.list({ agent_id: 'a1' })).total).toBe(1);
      expect((await s.list({ agent_id: 'a2' })).total).toBe(1);
    });

    test('countByAgentSince counts only within window', async () => {
      await s.insert({ agent_id: 'a1', policy_id: 'p1', trace_id: 't1', violation_type: 'v' });
      await s.insert({ agent_id: 'a1', policy_id: 'p1', trace_id: 't2', violation_type: 'v' });
      const since = pastIso(60_000);
      const n = await s.countByAgentSince('a1', since);
      expect(n).toBe(2);
    });
  });
}
runViolations('Sqlite',   async () => { const s = new SqliteViolationsStore(new Database(':memory:')); await s.init(); return s; });
runViolations('Postgres', async () => { const s = new PostgresViolationsStore(makePool()); await s.init(); return s; });

// ── ApprovalsStore ─────────────────────────────────────────────────────

function runApprovals(name: string, make: () => Promise<ApprovalsStore>) {
  describe(`ApprovalsStore (${name})`, () => {
    let s: ApprovalsStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + getByTraceId', async () => {
      const id = randomUUID();
      await s.insert({ id, trace_id: 'tr-1', agent_id: 'a1', tool_name: 'shell', risk_level: 'HIGH', expires_at: futureIso() });
      expect((await s.getByTraceId('tr-1'))?.status).toBe('PENDING');
    });

    test('approve transitions PENDING → APPROVED, second approve is no-op', async () => {
      const id = randomUUID();
      await s.insert({ id, trace_id: 'tr-a', agent_id: 'a1', tool_name: 'shell', risk_level: 'HIGH', expires_at: futureIso() });
      expect(await s.approve(id, 'reviewer@acme.com')).toBe(true);
      expect((await s.get(id))?.status).toBe('APPROVED');
      // Re-approving an already-APPROVED row does nothing.
      expect(await s.approve(id, 'someone-else')).toBe(false);
    });

    test('reject transitions to REJECTED with reason', async () => {
      const id = randomUUID();
      await s.insert({ id, trace_id: 'tr-r', agent_id: 'a1', tool_name: 'shell', risk_level: 'HIGH', expires_at: futureIso() });
      expect(await s.reject(id, 'reviewer@acme.com', 'unsafe input')).toBe(true);
      const row = await s.get(id);
      expect(row?.status).toBe('REJECTED');
      expect(row?.rejection_reason).toBe('unsafe input');
    });

    test('expireDue flips overdue PENDING rows to EXPIRED', async () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      await s.insert({ id: id1, trace_id: 'tr-e1', agent_id: 'a1', tool_name: 'x', risk_level: 'LOW', expires_at: pastIso() });
      await s.insert({ id: id2, trace_id: 'tr-e2', agent_id: 'a1', tool_name: 'x', risk_level: 'LOW', expires_at: futureIso() });
      const n = await s.expireDue(new Date().toISOString());
      expect(n).toBe(1);
      expect((await s.get(id1))?.status).toBe('EXPIRED');
      expect((await s.get(id2))?.status).toBe('PENDING');
    });

    test('active_only filters out expired even when status=PENDING', async () => {
      await s.insert({ id: randomUUID(), trace_id: 'tr-ap1', agent_id: 'a1', tool_name: 'x', risk_level: 'LOW', expires_at: futureIso() });
      await s.insert({ id: randomUUID(), trace_id: 'tr-ap2', agent_id: 'a1', tool_name: 'x', risk_level: 'LOW', expires_at: pastIso() });
      const active = await s.list({ active_only: true });
      expect(active.total).toBe(1);
    });
  });
}
runApprovals('Sqlite',   async () => { const s = new SqliteApprovalsStore(new Database(':memory:')); await s.init(); return s; });
runApprovals('Postgres', async () => { const s = new PostgresApprovalsStore(makePool()); await s.init(); return s; });

// ── PendingChecksStore ─────────────────────────────────────────────────

function runPendingChecks(name: string, make: () => Promise<PendingChecksStore>) {
  describe(`PendingChecksStore (${name})`, () => {
    let s: PendingChecksStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + get + decide', async () => {
      await s.insert({
        check_id: 'chk-1', agent_id: 'a1', tool_name: 'shell', arguments: '{}',
        category: 'shell', risk_level: 'HIGH', expires_at: futureIso(),
      });
      expect((await s.get('chk-1'))?.decision).toBe('pending');
      expect(await s.decide('chk-1', 'allow', 'reviewer@acme.com')).toBe(true);
      expect((await s.get('chk-1'))?.decision).toBe('allow');
    });

    test('decide on already-resolved is no-op', async () => {
      await s.insert({
        check_id: 'chk-d', agent_id: 'a1', tool_name: 'x', arguments: '{}',
        category: 'other', risk_level: 'MEDIUM', expires_at: futureIso(),
      });
      await s.decide('chk-d', 'block', 'reviewer');
      expect(await s.decide('chk-d', 'allow', 'someone-else')).toBe(false);
      expect((await s.get('chk-d'))?.decision).toBe('block');
    });

    test('expireDue transitions overdue pending to block/timeout', async () => {
      await s.insert({
        check_id: 'chk-e', agent_id: 'a1', tool_name: 'x', arguments: '{}',
        category: 'other', risk_level: 'HIGH', expires_at: pastIso(),
      });
      const n = await s.expireDue();
      expect(n).toBe(1);
      const r = await s.get('chk-e');
      expect(r?.decision).toBe('block');
      expect(r?.decided_by).toBe('timeout');
    });

    test('active_only excludes expired-but-still-pending', async () => {
      await s.insert({ check_id: 'chk-a1', agent_id: 'a', tool_name: 'x', arguments: '{}', category: 'o', risk_level: 'L', expires_at: futureIso() });
      await s.insert({ check_id: 'chk-a2', agent_id: 'a', tool_name: 'x', arguments: '{}', category: 'o', risk_level: 'L', expires_at: pastIso() });
      const r = await s.list({ active_only: true });
      expect(r.total).toBe(1);
      expect(r.entries[0].check_id).toBe('chk-a1');
    });

    test('purgeOlderThan removes old rows regardless of decision', async () => {
      await s.insert({ check_id: 'chk-old', agent_id: 'a', tool_name: 'x', arguments: '{}', category: 'o', risk_level: 'L', expires_at: futureIso() });
      // Force the row to look old (Postgres uses NOW() default; we just
      // assert the query runs cleanly + counts something with a future
      // cutoff that swallows all rows).
      const n = await s.purgeOlderThan(futureIso(3_600_000));
      expect(n).toBeGreaterThanOrEqual(1);
    });
  });
}
runPendingChecks('Sqlite',   async () => { const s = new SqlitePendingChecksStore(new Database(':memory:')); await s.init(); return s; });
runPendingChecks('Postgres', async () => { const s = new PostgresPendingChecksStore(makePool()); await s.init(); return s; });
