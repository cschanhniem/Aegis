/**
 * Phase C.1 store tests — 5 operational stores × 2 backends.
 *
 *   - AgentProfilesStore   (ML behaviour state, single row per agent)
 *   - AnomalyEventsStore   (Layer-2 events; top-by-score; window count)
 *   - SlaMetricsStore      (per-period uptime + percentile aggregates)
 *   - ScanHistoryStore     (pre-deploy scan rows w/ summary + detail)
 *   - DlqStore             (compensation_dlq lifecycle: pending → retried/dismissed)
 */
import Database from 'better-sqlite3';
import { newDb } from 'pg-mem';

import { SqliteAgentProfilesStore, PostgresAgentProfilesStore, type AgentProfilesStore } from '../db/agent-profiles-store';
import { SqliteAnomalyEventsStore, PostgresAnomalyEventsStore, type AnomalyEventsStore } from '../db/anomaly-events-store';
import { SqliteSlaMetricsStore,    PostgresSlaMetricsStore,    type SlaMetricsStore }    from '../db/sla-metrics-store';
import { SqliteScanHistoryStore,   PostgresScanHistoryStore,   type ScanHistoryStore }   from '../db/scan-history-store';
import { SqliteDlqStore,           PostgresDlqStore,           type DlqStore }           from '../db/dlq-store';

function makePool(): any {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}
const pastIso   = (ms = 3600_000) => new Date(Date.now() - ms).toISOString();

// ── AgentProfilesStore ───────────────────────────────────────────────

function runProfiles(name: string, make: () => Promise<AgentProfilesStore>) {
  describe(`AgentProfilesStore (${name})`, () => {
    let s: AgentProfilesStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('upsert + get', async () => {
      await s.upsert('a1', '{"mean":[1,2,3]}', 100);
      const row = await s.get('a1');
      expect(row?.profile_json).toBe('{"mean":[1,2,3]}');
      expect(row?.trace_count).toBe(100);
    });

    test('upsert replaces on conflict', async () => {
      await s.upsert('a1', '{}', 1);
      await s.upsert('a1', '{"v":1}', 5);
      const row = await s.get('a1');
      expect(row?.profile_json).toBe('{"v":1}');
      expect(row?.trace_count).toBe(5);
      expect((await s.list()).length).toBe(1);
    });

    test('delete removes the row', async () => {
      await s.upsert('a1', '{}', 1);
      expect(await s.delete('a1')).toBe(true);
      expect(await s.get('a1')).toBeNull();
    });
  });
}
runProfiles('Sqlite',   async () => { const s = new SqliteAgentProfilesStore(new Database(':memory:')); await s.init(); return s; });
runProfiles('Postgres', async () => { const s = new PostgresAgentProfilesStore(makePool()); await s.init(); return s; });

// ── AnomalyEventsStore ──────────────────────────────────────────────

function runAnomaly(name: string, make: () => Promise<AnomalyEventsStore>) {
  describe(`AnomalyEventsStore (${name})`, () => {
    let s: AnomalyEventsStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + list', async () => {
      await s.insert({ agent_id: 'a1', composite_score: 0.6, decision: 'escalate', signals: '[]' });
      await s.insert({ agent_id: 'a1', composite_score: 0.9, decision: 'block',    signals: '[]' });
      const r = await s.list({});
      expect(r.total).toBe(2);
    });

    test('topByScore returns highest-score events first', async () => {
      await s.insert({ agent_id: 'a1', composite_score: 0.6, decision: 'escalate', signals: '[]' });
      await s.insert({ agent_id: 'a1', composite_score: 0.9, decision: 'block', signals: '[]' });
      await s.insert({ agent_id: 'a2', composite_score: 0.7, decision: 'escalate', signals: '[]' });
      const top = await s.topByScore(pastIso(), 10);
      expect(top.length).toBeGreaterThanOrEqual(3);
      expect(top[0].composite_score).toBe(0.9);
    });

    test('countByAgentSince counts only that agent', async () => {
      await s.insert({ agent_id: 'a1', composite_score: 0.5, decision: 'escalate', signals: '[]' });
      await s.insert({ agent_id: 'a2', composite_score: 0.5, decision: 'escalate', signals: '[]' });
      expect(await s.countByAgentSince('a1', pastIso())).toBe(1);
      expect(await s.countByAgentSince('a2', pastIso())).toBe(1);
    });

    test('list filters by min_score', async () => {
      await s.insert({ agent_id: 'a1', composite_score: 0.4, decision: 'escalate', signals: '[]' });
      await s.insert({ agent_id: 'a1', composite_score: 0.8, decision: 'block',    signals: '[]' });
      const r = await s.list({ min_score: 0.7 });
      expect(r.total).toBe(1);
    });
  });
}
runAnomaly('Sqlite',   async () => { const s = new SqliteAnomalyEventsStore(new Database(':memory:')); await s.init(); return s; });
runAnomaly('Postgres', async () => { const s = new PostgresAnomalyEventsStore(makePool()); await s.init(); return s; });

// ── SlaMetricsStore ─────────────────────────────────────────────────

function runSla(name: string, make: () => Promise<SlaMetricsStore>) {
  describe(`SlaMetricsStore (${name})`, () => {
    let s: SlaMetricsStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    const period = '2026-06-05T10:00';

    test('merge insert then merge UPSERTs', async () => {
      await s.merge({ org_id: 'acme', period, endpoint: '/check', request_count: 10, error_count: 0, p50_ms: 5, p95_ms: 20, p99_ms: 50, avg_ms: 8 });
      await s.merge({ org_id: 'acme', period, endpoint: '/check', request_count: 5,  error_count: 1, p50_ms: 6, p95_ms: 22, p99_ms: 55, avg_ms: 9 });
      const rows = await s.query({ org_id: 'acme' });
      expect(rows.length).toBe(1);
      // Counters added; percentile snapshot replaced.
      expect(rows[0].request_count).toBe(15);
      expect(rows[0].error_count).toBe(1);
      expect(rows[0].p95_ms).toBe(22);
    });

    test('query filters by endpoint', async () => {
      await s.merge({ org_id: 'acme', period, endpoint: '/check', request_count: 1, error_count: 0, p50_ms: 1, p95_ms: 1, p99_ms: 1, avg_ms: 1 });
      await s.merge({ org_id: 'acme', period, endpoint: '/traces', request_count: 1, error_count: 0, p50_ms: 1, p95_ms: 1, p99_ms: 1, avg_ms: 1 });
      const r = await s.query({ org_id: 'acme', endpoint: '/check' });
      expect(r.length).toBe(1);
      expect(r[0].endpoint).toBe('/check');
    });

    test('summary computes uptime + percentile averages', async () => {
      // Use a period in the current hour so the 1-hour window in summary catches it.
      const recent = new Date().toISOString().substring(0, 16);
      await s.merge({ org_id: 'acme', period: recent, endpoint: '/check', request_count: 100, error_count: 5, p50_ms: 10, p95_ms: 50, p99_ms: 200, avg_ms: 20 });
      const sum = await s.summary('acme', 24);
      expect(sum.total_requests).toBe(100);
      expect(sum.total_errors).toBe(5);
      expect(sum.uptime_pct).toBeCloseTo(95, 1);
      expect(sum.p95).toBe(50);
    });
  });
}
runSla('Sqlite',   async () => { const s = new SqliteSlaMetricsStore(new Database(':memory:')); await s.init(); return s; });
runSla('Postgres', async () => { const s = new PostgresSlaMetricsStore(makePool()); await s.init(); return s; });

// ── ScanHistoryStore ────────────────────────────────────────────────

function runScanHistory(name: string, make: () => Promise<ScanHistoryStore>) {
  describe(`ScanHistoryStore (${name})`, () => {
    let s: ScanHistoryStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert returns id; list returns summary without sarif', async () => {
      const id = await s.insert({
        org_id: 'acme', scan_path: '/repo/a', scanned_at: new Date().toISOString(),
        tool_name: 'agentguard-scan', tool_version: '1.0.0',
        finding_count: 3, by_severity: '{"high":2}', by_tier: '{"tier-a":3}',
        findings_json: '[{"id":"f1"}]', sarif_json: '{"runs":[]}',
      });
      expect(typeof id).toBe('number');
      const list = await s.list({ org_id: 'acme' });
      expect(list.length).toBe(1);
      expect(list[0].finding_count).toBe(3);
      // summary path nulls the big blobs.
      expect(list[0].findings_json).toBeNull();
      expect(list[0].sarif_json).toBeNull();
    });

    test('get returns the full row including SARIF', async () => {
      const id = await s.insert({
        org_id: 'acme', scan_path: '/repo/b', scanned_at: new Date().toISOString(),
        tool_name: 'agentguard-scan', finding_count: 1,
        by_severity: '{}', by_tier: '{}',
        findings_json: '[{"id":"f2"}]', sarif_json: '{"v":1}',
      });
      const row = await s.get('acme', id);
      expect(row?.sarif_json).toBe('{"v":1}');
    });

    test('list scopes by org', async () => {
      await s.insert({ org_id: 'acme', scan_path: '/x', scanned_at: new Date().toISOString(),
                       tool_name: 't', finding_count: 0, by_severity: '{}', by_tier: '{}' });
      await s.insert({ org_id: 'beta', scan_path: '/y', scanned_at: new Date().toISOString(),
                       tool_name: 't', finding_count: 0, by_severity: '{}', by_tier: '{}' });
      expect((await s.list({ org_id: 'acme' })).length).toBe(1);
      expect((await s.list({ org_id: 'beta' })).length).toBe(1);
    });

    test('purgeOlderThan removes old rows', async () => {
      await s.insert({ org_id: 'acme', scan_path: '/x', scanned_at: pastIso(),
                       tool_name: 't', finding_count: 0, by_severity: '{}', by_tier: '{}' });
      const n = await s.purgeOlderThan('acme', new Date().toISOString());
      expect(n).toBeGreaterThanOrEqual(1);
    });
  });
}
runScanHistory('Sqlite',   async () => { const s = new SqliteScanHistoryStore(new Database(':memory:')); await s.init(); return s; });
runScanHistory('Postgres', async () => { const s = new PostgresScanHistoryStore(makePool()); await s.init(); return s; });

// ── DlqStore ────────────────────────────────────────────────────────

function runDlq(name: string, make: () => Promise<DlqStore>) {
  describe(`DlqStore (${name})`, () => {
    let s: DlqStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + pendingCount + list', async () => {
      await s.insert({ org_id: 'acme', trace_id: 't1', tool_name: 'shell', compensator_kind: 'noop', last_error: 'x', attempts_made: 3, planned_action: 'manual' });
      await s.insert({ org_id: 'acme', trace_id: 't2', tool_name: 'shell', compensator_kind: 'noop', last_error: 'y', attempts_made: 3, planned_action: 'manual' });
      expect(await s.pendingCount('acme')).toBe(2);
      const r = await s.list({ org_id: 'acme', status: 'pending' });
      expect(r.total).toBe(2);
    });

    test('retry transitions pending → retried', async () => {
      const id = await s.insert({ org_id: 'acme', trace_id: 't', tool_name: 'shell', compensator_kind: 'noop', last_error: 'x', attempts_made: 3, planned_action: 'manual' });
      expect(await s.retry('acme', id, 'reviewer', 'retrying now')).toBe(true);
      expect((await s.get('acme', id))?.status).toBe('retried');
      // Retrying again is a no-op (not pending anymore).
      expect(await s.retry('acme', id, 'reviewer')).toBe(false);
    });

    test('dismiss transitions pending → dismissed', async () => {
      const id = await s.insert({ org_id: 'acme', trace_id: 't', tool_name: 'shell', compensator_kind: 'noop', last_error: 'x', attempts_made: 3, planned_action: 'manual' });
      expect(await s.dismiss('acme', id, 'reviewer', 'wontfix')).toBe(true);
      const row = await s.get('acme', id);
      expect(row?.status).toBe('dismissed');
      expect(row?.resolution_note).toBe('wontfix');
    });

    test('cross-tenant get + retry are scoped', async () => {
      const id = await s.insert({ org_id: 'acme', trace_id: 't', tool_name: 'shell', compensator_kind: 'noop', last_error: 'x', attempts_made: 3, planned_action: 'manual' });
      expect(await s.get('beta', id)).toBeNull();
      expect(await s.retry('beta', id, 'attacker')).toBe(false);
    });
  });
}
runDlq('Sqlite',   async () => { const s = new SqliteDlqStore(new Database(':memory:')); await s.init(); return s; });
runDlq('Postgres', async () => { const s = new PostgresDlqStore(makePool()); await s.init(); return s; });
