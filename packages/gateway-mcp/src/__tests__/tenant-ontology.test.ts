import Database from 'better-sqlite3';
import pino from 'pino';
import { DetectorRegistry } from '../detectors/registry';
import { CoverageMapService } from '../services/coverage-map';
import { TenantConfigService } from '../services/tenant-config';
import { ConfigBus } from '../services/config-bus';
import { AuditLogService } from '../services/audit-log';
import { TenantOntologyNodeSchema, Detector } from '@agentguard/core-schema';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, plan TEXT, settings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO organizations (id, name, slug, plan) VALUES ('org-A', 'a', 'a', 'community');
    INSERT INTO organizations (id, name, slug, plan) VALUES ('org-B', 'b', 'b', 'community');
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, user_id TEXT, user_email TEXT, action TEXT,
      resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const logger = pino({ level: 'silent' });
  const audit = new AuditLogService(db, logger);
  const bus = new ConfigBus(logger);
  const tc = new TenantConfigService(db, logger, bus, audit);
  tc.seedDefaults();
  const reg = new DetectorRegistry();
  const coverage = new CoverageMapService(reg, tc);
  return { db, tc, reg, coverage };
}

const fakeDetector = (name: string, coverage: string[]): Detector => ({
  name, version: '1.0.0', kind: 'content', coverage, evaluate: () => [],
});

describe('TenantOntologyNode schema', () => {
  it('rejects an id outside the TENANT. namespace', () => {
    expect(() => TenantOntologyNodeSchema.parse({
      id: 'CUSTOM.X', tactic: 'execution', title: 't', summary: 's',
    })).toThrow();
  });

  it('accepts a valid TENANT.* spec', () => {
    const n = TenantOntologyNodeSchema.parse({
      id: 'TENANT.PROJECT-AURORA',
      tactic: 'data-exfiltration',
      title: 'Project Aurora codename leak',
      summary: 'Internal product codename appears in outbound tool args.',
    });
    expect(n.id).toBe('TENANT.PROJECT-AURORA');
  });
});

describe('CoverageMapService — tenant nodes', () => {
  it('summary(orgId) shows AAT-T* canonical nodes only when tenant has no extensions', () => {
    const { coverage } = setup();
    const summary = coverage.summary('org-A');
    const ids = summary.entries.map(e => e.nodeId);
    expect(ids.every(id => id.startsWith('AAT-T'))).toBe(true);
  });

  it('summary(orgId) includes the tenant\'s TENANT.* nodes', () => {
    const { tc, coverage } = setup();
    tc.update('org-A', {
      ontologyNodes: [{
        id: 'TENANT.IP-LEAK', tactic: 'data-exfiltration',
        title: 'Internal IP leak', summary: 's',
      }] as any,
    }, { userEmail: 't' });
    const summary = coverage.summary('org-A');
    const ids = summary.entries.map(e => e.nodeId);
    expect(ids).toContain('TENANT.IP-LEAK');
  });

  it('TENANT.* nodes from org-A do not appear on org-B coverage', () => {
    const { tc, coverage } = setup();
    tc.update('org-A', {
      ontologyNodes: [{
        id: 'TENANT.A-ONLY', tactic: 'execution', title: 't', summary: 's',
      }] as any,
    }, { userEmail: 't' });
    const summary = coverage.summary('org-B');
    expect(summary.entries.find(e => e.nodeId === 'TENANT.A-ONLY')).toBeUndefined();
  });

  it('detector covering a tenant node lights it up as covered', () => {
    const { tc, reg, coverage } = setup();
    tc.update('org-A', {
      ontologyNodes: [{
        id: 'TENANT.LEAK', tactic: 'data-exfiltration', title: 't', summary: 's',
      }] as any,
    }, { userEmail: 't' });
    reg.register(fakeDetector('tenant.org-A.custom-leak', ['TENANT.LEAK']));
    const summary = coverage.summary('org-A');
    const entry = summary.entries.find(e => e.nodeId === 'TENANT.LEAK')!;
    expect(entry.covered).toBe(true);
    expect(entry.coveringDetectors.map(d => d.name)).toContain('tenant.org-A.custom-leak');
  });

  it('detector claiming unknown tenant node ID gets dropped from coverage (defense in depth)', () => {
    const { reg, coverage } = setup();
    reg.register(fakeDetector('detector-A', ['TENANT.NONEXISTENT']));
    const summary = coverage.summary('org-A');
    expect(summary.entries.find(e => e.nodeId === 'TENANT.NONEXISTENT')).toBeUndefined();
  });

  it('forwardMap is tenant-scoped — same canonical node lights up identically across orgs', () => {
    const { reg, coverage } = setup();
    reg.register(fakeDetector('aegis.builtin.x', ['AAT-T7001']));
    const a = coverage.forwardMap('org-A');
    const b = coverage.forwardMap('org-B');
    expect(a.has('AAT-T7001')).toBe(true);
    expect(b.has('AAT-T7001')).toBe(true);
  });
});
