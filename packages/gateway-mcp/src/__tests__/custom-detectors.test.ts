import Database from 'better-sqlite3';
import pino from 'pino';
import {
  CustomDetectorSpec,
  CustomDetectorSpecSchema,
  DetectorContext,
} from '@agentguard/core-schema';
import { DeclarativeDetector } from '../detectors/declarative-detector';
import { DetectorRegistry } from '../detectors/registry';
import { CustomDetectorService } from '../services/custom-detector-service';
import { TenantConfigService } from '../services/tenant-config';
import { ConfigBus } from '../services/config-bus';
import { AuditLogService } from '../services/audit-log';

function ctx(over: Partial<DetectorContext> = {}): DetectorContext {
  return {
    tool: { name: 'web_search', args: { q: 'hello' } },
    agent: { id: 'a-1' },
    tenant: { id: 'default' },
    ...over,
  };
}

function asSpec(s: any): CustomDetectorSpec {
  return CustomDetectorSpecSchema.parse(s);
}

// ── Spec validation ──────────────────────────────────────────────────────

describe('CustomDetectorSpec parsing', () => {
  it('accepts a minimal spec', () => {
    const s = asSpec({
      name: 'mrn-leak',
      rules: [{ emit: { severity: 'warn', category: 'phi.mrn', message: 'MRN-shaped value' } }],
    });
    expect(s.kind).toBe('content');
    expect(s.enabled).toBe(true);
  });

  it('rejects bad detector name', () => {
    expect(() => asSpec({ name: 'Bad NAME', rules: [{ emit: { severity: 'warn', category: 'x', message: 'y' } }] })).toThrow();
  });

  it('rejects ontology IDs outside AAT-T* or TENANT.* namespace', () => {
    expect(() => asSpec({
      name: 'x', rules: [{ emit: { severity: 'warn', category: 'x', message: 'y', ontology: ['CUSTOM-FOO'] } }],
    })).toThrow();
  });

  it('accepts TENANT.* ontology IDs', () => {
    const s = asSpec({
      name: 'x',
      coverage: ['TENANT.MRN-LEAK'],
      rules: [{ emit: { severity: 'warn', category: 'x', message: 'y', ontology: ['TENANT.MRN-LEAK'] } }],
    });
    expect(s.coverage).toContain('TENANT.MRN-LEAK');
  });
});

// ── DeclarativeDetector evaluation ──────────────────────────────────────

describe('DeclarativeDetector', () => {
  it('emits per matching rule', () => {
    const d = new DeclarativeDetector('default', asSpec({
      name: 'sql-injection',
      rules: [{
        when: { arg_string_pattern: "[Ss][Ee][Ll][Ee][Cc][Tt]\\s+.*\\s+[Ff][Rr][Oo][Mm]\\s+\\w+" },
        emit: { severity: 'critical', category: 'risk.sql_injection', message: 'SQL pattern' },
      }],
    }));
    const r = d.evaluate(ctx({ tool: { name: 'run_query', args: { sql: "SELECT * FROM users" } } }));
    expect(r.length).toBe(1);
    expect(r[0].category).toBe('risk.sql_injection');
  });

  it('per-tenant scoped — silent on other tenant', () => {
    const d = new DeclarativeDetector('org-A', asSpec({
      name: 'x',
      rules: [{ emit: { severity: 'warn', category: 'x.y', message: 'always' } }],
    }));
    // No `when` means always-match. Should fire for org-A but not org-B.
    expect(d.evaluate(ctx({ tenant: { id: 'org-A' } })).length).toBe(1);
    expect(d.evaluate(ctx({ tenant: { id: 'org-B' } }))).toEqual([]);
  });

  it('tool_name_pattern + arg_path with all/any/not', () => {
    const d = new DeclarativeDetector('default', asSpec({
      name: 'pricing-leak',
      rules: [{
        when: {
          all: [
            { tool_name_pattern: '^(send|email|webhook)' },
            { arg_path: 'body', arg_path_pattern: 'internal-pricing-2026' },
            { not: { arg_path: 'recipient', arg_path_pattern: '@acme\\.com$' } },
          ],
        },
        emit: { severity: 'critical', category: 'tenant.pricing-leak', message: 'internal pricing leaving acme.com' },
      }],
    }));
    expect(d.evaluate(ctx({
      tool: { name: 'send_email', args: { body: 'see internal-pricing-2026 q1', recipient: 'a@evil.com' } },
    })).length).toBe(1);
    // recipient is internal → not condition fails → no match
    expect(d.evaluate(ctx({
      tool: { name: 'send_email', args: { body: 'see internal-pricing-2026 q1', recipient: 'a@acme.com' } },
    }))).toEqual([]);
    // body is benign → match clause fails
    expect(d.evaluate(ctx({
      tool: { name: 'send_email', args: { body: 'hi', recipient: 'a@evil.com' } },
    }))).toEqual([]);
  });

  it('enabled=false short-circuits to no signals', () => {
    const d = new DeclarativeDetector('default', asSpec({
      name: 'always', enabled: false,
      rules: [{ emit: { severity: 'critical', category: 'x.y', message: 'always' } }],
    }));
    expect(d.evaluate(ctx())).toEqual([]);
  });

  it('inherits top-level coverage when rule omits ontology', () => {
    const d = new DeclarativeDetector('default', asSpec({
      name: 'x',
      coverage: ['TENANT.IP-LEAK'],
      rules: [{ emit: { severity: 'warn', category: 'tenant.ip-leak', message: 'oops' } }],
    }));
    const r = d.evaluate(ctx());
    expect(r[0].ontology).toContain('TENANT.IP-LEAK');
  });
});

// ── CustomDetectorService lifecycle ─────────────────────────────────────

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, plan TEXT, settings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, user_id TEXT, user_email TEXT, action TEXT, resource_type TEXT,
      resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO organizations (id, name, slug, plan) VALUES ('default', 'd', 'd', 'community');
    INSERT INTO organizations (id, name, slug, plan) VALUES ('org-2',   'b', 'b', 'community');
  `);
  const logger = pino({ level: 'silent' });
  const audit = new AuditLogService(db, logger);
  const bus = new ConfigBus(logger);
  const tc = new TenantConfigService(db, logger, bus, audit);
  tc.seedDefaults();
  const reg = new DetectorRegistry();
  const svc = new CustomDetectorService(logger, reg, tc, bus);
  return { db, tc, bus, reg, svc };
}

describe('CustomDetectorService lifecycle', () => {
  it('registers configured detectors on start', () => {
    const { tc, reg, svc } = setup();
    tc.update('default', {
      customDetectors: [{
        name: 'pii-mrn',
        rules: [{ emit: { severity: 'warn', category: 'phi.mrn', message: 'MRN' } }],
      }] as any,
    }, { userEmail: 't' });
    svc.start(['default']);
    expect(reg.get('tenant.default.pii-mrn')).toBeDefined();
  });

  it('hot-reloads on tenant config update', () => {
    const { tc, reg, svc } = setup();
    svc.start(['default']);
    expect(reg.list().filter(d => d.name.startsWith('tenant.')).length).toBe(0);
    tc.update('default', {
      customDetectors: [{
        name: 'add-me',
        rules: [{ emit: { severity: 'info', category: 'x', message: 'y' } }],
      }] as any,
    }, { userEmail: 't' });
    expect(reg.get('tenant.default.add-me')).toBeDefined();
  });

  it('drops removed detectors on hot-reload', () => {
    const { tc, reg, svc } = setup();
    tc.update('default', {
      customDetectors: [
        { name: 'a', rules: [{ emit: { severity: 'info', category: 'x', message: 'y' } }] },
        { name: 'b', rules: [{ emit: { severity: 'info', category: 'x', message: 'y' } }] },
      ] as any,
    }, { userEmail: 't' });
    svc.start(['default']);
    expect(reg.get('tenant.default.a')).toBeDefined();
    expect(reg.get('tenant.default.b')).toBeDefined();
    tc.update('default', {
      customDetectors: [
        { name: 'a', rules: [{ emit: { severity: 'info', category: 'x', message: 'y' } }] },
      ] as any,
    }, { userEmail: 't' });
    expect(reg.get('tenant.default.a')).toBeDefined();
    expect(reg.get('tenant.default.b')).toBeUndefined();
  });

  it('skips an invalid spec but keeps siblings', () => {
    const { tc, reg, svc, bus } = setup();
    svc.start(['default']);
    // Inject one good + one that throws at compile. We bypass Zod by
    // directly emitting a ConfigBus event with mixed specs (the API
    // layer would have rejected this, but we simulate persistence skew).
    const good: CustomDetectorSpec = asSpec({
      name: 'ok',
      rules: [{ emit: { severity: 'info', category: 'x', message: 'y' } }],
    });
    const bad = { name: 'bad', version: '1.0.0', kind: 'content', coverage: [], enabled: true,
                  rules: [{ when: { tool_name_pattern: '(' /* unterminated regex */ },
                             emit: { severity: 'warn', category: 'x', message: 'y' } }] } as any;
    tc.update('default', { customDetectors: [good, bad] }, { userEmail: 't' });
    expect(reg.get('tenant.default.ok')).toBeDefined();
    expect(reg.get('tenant.default.bad')).toBeUndefined();
  });
});
