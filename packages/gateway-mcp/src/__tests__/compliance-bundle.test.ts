import Database from 'better-sqlite3';
import pino from 'pino';
import { createPublicKey, verify as edVerify } from 'crypto';
import { DetectorRegistry } from '../detectors/registry';
import { ClassifierDetector } from '../detectors/built-in/classifier-detector';
import { PiiDetector } from '../detectors/built-in/pii-detector';
import { CoverageMapService } from '../services/coverage-map';
import { ComplianceBundleService } from '../services/compliance-bundle';
import { SigningService } from '../services/signing';
import { TransparencyLogService } from '../services/transparency-log';
import { controlsFor, listFrameworks } from '../services/compliance-controls';
import { ComplianceControlSource } from '../services/compliance-source';
import { AuditLogService } from '../services/audit-log';
import { TenantConfigService } from '../services/tenant-config';
import { ConfigBus } from '../services/config-bus';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, plan TEXT, settings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO organizations (id, name, slug, plan) VALUES ('default', 'd', 'd', 'community');
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, user_id TEXT, user_email TEXT,
      action TEXT, resource_type TEXT, resource_id TEXT,
      details TEXT, ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gateway_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE transparency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leaf_hash TEXT NOT NULL, payload TEXT NOT NULL,
      source TEXT NOT NULL, org_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const logger = pino({ level: 'silent' });
  const registry = new DetectorRegistry();
  registry.register(new ClassifierDetector());
  registry.register(new PiiDetector());
  const coverage = new CoverageMapService(registry);
  const signer = new SigningService(db, logger);
  const tlog = new TransparencyLogService(db, signer, logger);
  const audit = new AuditLogService(db, logger);
  const bus = new ConfigBus(logger);
  const tc = new TenantConfigService(db, logger, bus, audit);
  tc.seedDefaults();
  const src = new ComplianceControlSource(tc);
  const svc = new ComplianceBundleService(db, logger, registry, coverage, signer, src, tlog);
  return { db, svc, signer, tlog, registry, tc };
}

describe('compliance-controls definitions', () => {
  it('lists 4 frameworks', () => {
    const fws = listFrameworks();
    expect([...fws].sort()).toEqual(['eu-ai-act', 'iso27001', 'nist-ai-rmf', 'soc2']);
  });

  it('every framework has at least 3 controls', () => {
    for (const fw of listFrameworks()) {
      expect(controlsFor(fw).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('control ids are unique within a framework', () => {
    for (const fw of listFrameworks()) {
      const ids = controlsFor(fw).map(c => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('ComplianceBundleService.generate', () => {
  it('produces a bundle with one entry per control', () => {
    const { svc } = setup();
    const b = svc.generate({ framework: 'soc2', orgId: 'default' });
    expect(b.framework).toBe('soc2');
    expect(b.controls).toHaveLength(controlsFor('soc2').length);
    expect(b.summary.total_controls).toBe(b.controls.length);
  });

  it('includes detector_registered field when control names match', () => {
    const { svc } = setup();
    const b = svc.generate({ framework: 'soc2', orgId: 'default' });
    const cc67 = b.controls.find(c => c.id === 'CC6.7')!;
    expect(cc67.evidence.detectors_registered?.find(d => d.name === 'aegis.builtin.pii')).toBeDefined();
  });

  it('attaches signed bundle hash that verifies against the embedded public key', () => {
    const { svc } = setup();
    const b = svc.generate({ framework: 'iso27001', orgId: 'default' });
    expect(b.bundle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.signature.algorithm).toBe('ed25519');
    expect(b.signature.public_key_pem).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });

  it('appends an entry to the transparency log', () => {
    const { svc, tlog } = setup();
    const before = tlog.size();
    const b = svc.generate({ framework: 'nist-ai-rmf', orgId: 'default' });
    expect(tlog.size()).toBe(before + 1);
    expect(b.transparency_log_entry?.index).toBe(before + 1);
  });

  it('counts audit rows by action under the audit-action-counts spec', () => {
    const { db, svc } = setup();
    // Seed two user.create rows + one apikey.revoke row, all org=default.
    db.prepare(`INSERT INTO admin_audit_log (org_id, action, resource_type) VALUES (?, ?, ?)`).run('default', 'user.create', 'user');
    db.prepare(`INSERT INTO admin_audit_log (org_id, action, resource_type) VALUES (?, ?, ?)`).run('default', 'user.create', 'user');
    db.prepare(`INSERT INTO admin_audit_log (org_id, action, resource_type) VALUES (?, ?, ?)`).run('default', 'apikey.revoke', 'apikey');

    const b = svc.generate({ framework: 'soc2', orgId: 'default' });
    const cc61 = b.controls.find(c => c.id === 'CC6.1')!;
    expect(cc61.evidence.audit_action_counts?.['user.create']).toBe(2);
    expect(cc61.evidence.audit_action_counts?.['apikey.revoke']).toBe(1);
  });

  it('status=covered when every detector + ontology node satisfied; partial otherwise', () => {
    const { svc, registry } = setup();
    // Only classifier + PII registered → CC6.6 spec needs classifier + tool-scope.
    const b = svc.generate({ framework: 'soc2', orgId: 'default' });
    const cc66 = b.controls.find(c => c.id === 'CC6.6')!;
    expect(cc66.status).toBe('partial');   // missing tool-scope detector
  });

  it('bundle hash varies with gateway state (transparency root advances each call)', () => {
    const { svc } = setup();
    const a = svc.generate({ framework: 'soc2', orgId: 'default' });
    const b = svc.generate({ framework: 'soc2', orgId: 'default' });
    // Each call appends to the transparency log, which mutates the
    // root_hash carried in artifacts → bundle_hash differs by design.
    expect(a.bundle_hash).not.toBe(b.bundle_hash);
  });
});

describe('Bundle signature is verifiable offline', () => {
  it('round-trip: signer-produced signature verifies with the bundle-attached pubkey', () => {
    const { svc } = setup();
    const bundle = svc.generate({ framework: 'eu-ai-act', orgId: 'default' });

    // Reconstruct the canonical body the service signed.
    const bodyForHash = {
      framework: bundle.framework,
      org_id: bundle.org_id,
      ontology_version: bundle.ontology_version,
      controls: bundle.controls,
      summary: bundle.summary,
    };
    const canonical = canonicalize(bodyForHash);
    const pub = createPublicKey(bundle.signature.public_key_pem);
    const sig = Buffer.from(bundle.signature.signature, 'base64');
    const ok = edVerify(null, Buffer.from(canonical, 'utf8'), pub, sig);
    expect(ok).toBe(true);
  });
});

// ── Tenant-registered custom frameworks ─────────────────────────────────

describe('Custom compliance framework registration', () => {
  it('source lists built-ins + tenant customs', () => {
    const { svc, tc } = setup();
    tc.update('default', {
      customComplianceFrameworks: [{
        id: 'pci-dss-4',
        name: 'PCI DSS v4.0',
        controls: [{
          id: 'REQ-3.4',
          title: 'Render PAN unreadable',
          summary: 'Card numbers must not appear in cleartext in tool args.',
          evidenceSpec: {
            detectors: ['aegis.builtin.pii'],
            ontology: ['AAT-T4001'],
          },
        }],
      }] as any,
    }, { userEmail: 't' });
    const src = new ComplianceControlSource(tc);
    const ids = src.list('default').map(f => f.id);
    expect(ids).toContain('soc2');
    expect(ids).toContain('pci-dss-4');
  });

  it('bundle generator works for a custom framework just like a built-in', () => {
    const { svc, tc } = setup();
    tc.update('default', {
      customComplianceFrameworks: [{
        id: 'pci-dss-4',
        name: 'PCI DSS v4.0',
        controls: [{
          id: 'REQ-3.4',
          title: 'Render PAN unreadable',
          summary: 'PAN must be redacted before leaving the trust boundary.',
          evidenceSpec: { detectors: ['aegis.builtin.pii'], ontology: ['AAT-T4001'] },
        }],
      }] as any,
    }, { userEmail: 't' });

    const bundle = svc.generate({ framework: 'pci-dss-4', orgId: 'default' });
    expect(bundle.framework).toBe('pci-dss-4');
    expect(bundle.controls.length).toBe(1);
    expect(bundle.controls[0].id).toBe('REQ-3.4');
    // PII detector is registered → status should be covered.
    expect(bundle.controls[0].status).toBe('covered');
    // Bundle hash + signature should still be present.
    expect(bundle.bundle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.signature.algorithm).toBe('ed25519');
  });

  it('source.exists treats built-ins and customs uniformly', () => {
    const { tc } = setup();
    tc.update('default', {
      customComplianceFrameworks: [{
        id: 'hipaa', name: 'HIPAA',
        controls: [{ id: 'X', title: 't', summary: 's', evidenceSpec: {} }],
      }] as any,
    }, { userEmail: 't' });
    const src = new ComplianceControlSource(tc);
    expect(src.exists('default', 'soc2')).toBe(true);
    expect(src.exists('default', 'hipaa')).toBe(true);
    expect(src.exists('default', 'nope')).toBe(false);
  });
});

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return '{' + entries.map(([k, val]) => JSON.stringify(k) + ':' + canonicalize(val)).join(',') + '}';
}
