import Database from 'better-sqlite3';
import pino from 'pino';

import { ScanHistoryService } from '../services/scan-history';
import { ScanReport, AegisFinding } from '../services/predeploy-scan';

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  const findings: AegisFinding[] = [
    {
      rule_id: 'AGENT-001', title: 'Prompt injection', severity: 'critical', tier: 'BLOCK',
      owasp_id: 'ASI-01', cwe_id: 'CWE-94', confidence: 0.95,
      location: { file_path: 'src/agent.py', start_line: 42 },
    },
    {
      rule_id: 'AGENT-007', title: 'Hardcoded secret', severity: 'high', tier: 'BLOCK',
      cwe_id: 'CWE-798',
      location: { file_path: 'src/keys.py', start_line: 3 },
    },
  ];
  return {
    ok: true,
    tool: { name: 'agent-audit', version: '0.18.2' },
    findings,
    summary: { total: 2, by_severity: { critical: 1, high: 1 }, by_tier: { BLOCK: 2 } },
    scanned_at: new Date().toISOString(),
    scan_path: '/repos/acme-bot',
    sarif: { runs: [{ tool: { driver: { name: 'agent-audit' } }, results: [] }], version: '2.1.0' },
    ...overrides,
  };
}

function setup() {
  const db = new Database(':memory:');
  const logger = pino({ level: 'silent' });
  return { db, svc: new ScanHistoryService(db, logger) };
}

describe('ScanHistoryService', () => {
  it('ingest returns rowid + persists every field', () => {
    const { svc } = setup();
    const id = svc.ingest({ orgId: 'org-1', scannedBy: 'justin@example.com', report: makeReport() });
    expect(id).toBeGreaterThan(0);
    const row = svc.get({ orgId: 'org-1', id })!;
    expect(row.scan_path).toBe('/repos/acme-bot');
    expect(row.tool_name).toBe('agent-audit');
    expect(row.tool_version).toBe('0.18.2');
    expect(row.scanned_by).toBe('justin@example.com');
    expect(row.finding_count).toBe(2);
    expect(row.by_severity).toEqual({ critical: 1, high: 1 });
    expect(row.by_tier).toEqual({ BLOCK: 2 });
    expect(row.findings).toHaveLength(2);
    expect((row.sarif as any).version).toBe('2.1.0');
  });

  it('list returns rows in scanned_at DESC order without finding/sarif blobs', () => {
    const { svc } = setup();
    svc.ingest({ orgId: 'org-1', report: makeReport({ scanned_at: '2026-05-01T00:00:00Z' }) });
    svc.ingest({ orgId: 'org-1', report: makeReport({ scanned_at: '2026-06-01T00:00:00Z' }) });
    svc.ingest({ orgId: 'org-1', report: makeReport({ scanned_at: '2026-05-15T00:00:00Z' }) });
    const rows = svc.list({ orgId: 'org-1' });
    expect(rows).toHaveLength(3);
    expect(rows[0].scanned_at).toBe('2026-06-01T00:00:00Z');
    expect(rows[1].scanned_at).toBe('2026-05-15T00:00:00Z');
    expect(rows[2].scanned_at).toBe('2026-05-01T00:00:00Z');
    for (const r of rows) {
      expect(r.findings).toBeUndefined();
      expect(r.sarif).toBeUndefined();
    }
  });

  it('list filters by path', () => {
    const { svc } = setup();
    svc.ingest({ orgId: 'org-1', report: makeReport({ scan_path: '/repos/a' }) });
    svc.ingest({ orgId: 'org-1', report: makeReport({ scan_path: '/repos/b' }) });
    const rows = svc.list({ orgId: 'org-1', path: '/repos/a' });
    expect(rows).toHaveLength(1);
    expect(rows[0].scan_path).toBe('/repos/a');
  });

  it('list filters by since', () => {
    const { svc } = setup();
    svc.ingest({ orgId: 'org-1', report: makeReport({ scanned_at: '2026-01-01T00:00:00Z' }) });
    svc.ingest({ orgId: 'org-1', report: makeReport({ scanned_at: '2026-06-01T00:00:00Z' }) });
    const rows = svc.list({ orgId: 'org-1', since: '2026-03-01T00:00:00Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].scanned_at).toBe('2026-06-01T00:00:00Z');
  });

  it('list scopes by org_id (no cross-tenant leakage)', () => {
    const { svc } = setup();
    svc.ingest({ orgId: 'org-1', report: makeReport() });
    svc.ingest({ orgId: 'org-2', report: makeReport() });
    expect(svc.list({ orgId: 'org-1' })).toHaveLength(1);
    expect(svc.list({ orgId: 'org-2' })).toHaveLength(1);
  });

  it('get returns null on wrong tenant', () => {
    const { svc } = setup();
    const id = svc.ingest({ orgId: 'org-1', report: makeReport() });
    expect(svc.get({ orgId: 'org-2', id })).toBeNull();
  });

  it('list limit clamps to [1, 500]', () => {
    const { svc } = setup();
    for (let i = 0; i < 20; i++) svc.ingest({ orgId: 'org-1', report: makeReport() });
    expect(svc.list({ orgId: 'org-1', limit: 5 })).toHaveLength(5);
    expect(svc.list({ orgId: 'org-1', limit: 0 }).length).toBeGreaterThanOrEqual(1);
    expect(svc.list({ orgId: 'org-1', limit: 10_000 }).length).toBeLessThanOrEqual(500);
  });

  it('delete removes only the matching scoped row', () => {
    const { svc } = setup();
    const idA = svc.ingest({ orgId: 'org-A', report: makeReport() });
    const idB = svc.ingest({ orgId: 'org-B', report: makeReport() });
    expect(svc.delete({ orgId: 'org-B', id: idA })).toBe(false);  // wrong tenant
    expect(svc.list({ orgId: 'org-A' })).toHaveLength(1);
    expect(svc.delete({ orgId: 'org-A', id: idA })).toBe(true);
    expect(svc.list({ orgId: 'org-A' })).toHaveLength(0);
    expect(svc.list({ orgId: 'org-B' })).toHaveLength(1);
  });

  it('persists scan even when sarif blob is absent', () => {
    const { svc } = setup();
    const reportWithoutSarif = makeReport();
    delete (reportWithoutSarif as any).sarif;
    const id = svc.ingest({ orgId: 'org-1', report: reportWithoutSarif });
    const row = svc.get({ orgId: 'org-1', id })!;
    expect(row.findings).toHaveLength(2);
    expect(row.sarif).toBeUndefined();
  });
});
