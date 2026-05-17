/**
 * TenantConfigService — unit tests (in-memory SQLite).
 */
import Database from 'better-sqlite3';
import pino from 'pino';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { ConfigBus, ConfigEvent } from '../services/config-bus';
import { TenantConfigService } from '../services/tenant-config';
import { AuditLogService } from '../services/audit-log';

const silentLogger = pino({ level: 'silent' });

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal traces table so the ALTER migration in enterprise-schema doesn't blow up
  db.exec(`CREATE TABLE IF NOT EXISTS traces (trace_id TEXT PRIMARY KEY)`);
  initializeEnterpriseSchema(db);
  return db;
}

function makeService(db = makeDb()) {
  const bus = new ConfigBus(silentLogger);
  const audit = new AuditLogService(db, silentLogger);
  const service = new TenantConfigService(db, silentLogger, bus, audit);
  return { db, bus, audit, service };
}

describe('TenantConfigService.get', () => {
  test('returns standard template defaults when settings is empty', () => {
    const { service } = makeService();
    const cfg = service.get('default');
    expect(cfg.deploymentMode).toBe('standard');
    expect(cfg.layers.l1.enabled).toBe(true);
    expect(cfg.layers.l2.enabled).toBe(true);
    expect(cfg.retention.days).toBe(90);
  });

  test('returns defaults for non-existent org (no DB row)', () => {
    const { service } = makeService();
    const cfg = service.get('does-not-exist');
    expect(cfg.deploymentMode).toBe('standard');
  });
});

describe('TenantConfigService.seedDefaults', () => {
  test('seeds the default org once and is idempotent', () => {
    const { db, service } = makeService();
    const first = service.seedDefaults();
    expect(first.seeded).toBeGreaterThanOrEqual(1);

    const stored = db
      .prepare('SELECT settings FROM organizations WHERE id = ?')
      .get('default') as { settings: string };
    const parsed = JSON.parse(stored.settings);
    expect(parsed.deploymentMode).toBe('standard');

    const second = service.seedDefaults();
    expect(second.seeded).toBe(0);
  });

  test('does not overwrite non-empty settings', () => {
    const { db, service } = makeService();
    db.prepare(
      'UPDATE organizations SET settings = ? WHERE id = ?',
    ).run(JSON.stringify({ custom: true }), 'default');
    const result = service.seedDefaults();
    expect(result.seeded).toBe(0);
  });
});

describe('TenantConfigService.applyTemplate', () => {
  test('replaces config with the named template', () => {
    const { service } = makeService();
    service.seedDefaults();
    const cfg = service.applyTemplate('default', 'financial', {});
    expect(cfg.deploymentMode).toBe('financial');
    expect(cfg.retention.days).toBe(2555);
    expect(cfg.retention.enforcePII).toBe(true);
  });

  test('unknown template returns 404 status on thrown error', () => {
    const { service } = makeService();
    service.seedDefaults();
    expect(() => service.applyTemplate('default', 'nope' as any, {})).toThrow();
    try {
      service.applyTemplate('default', 'nope' as any, {});
    } catch (e: any) {
      expect(e.status).toBe(404);
    }
  });

  test('emits a tenant.config.updated event with source apply-template', () => {
    const { service, bus } = makeService();
    service.seedDefaults();
    const events: ConfigEvent[] = [];
    bus.onConfigChange((e) => events.push(e));
    service.applyTemplate('default', 'strict', {});
    const last = events[events.length - 1];
    expect(last.type).toBe('tenant.config.updated');
    if (last.type === 'tenant.config.updated') {
      expect(last.orgId).toBe('default');
      expect(last.source).toBe('apply-template');
      expect(last.config.deploymentMode).toBe('strict');
    }
  });
});

describe('TenantConfigService.update', () => {
  test('deep-merges a partial threshold update', () => {
    const { service } = makeService();
    service.seedDefaults();
    const before = service.get('default');
    const after = service.update(
      'default',
      { thresholds: { anomalyScore: 0.95 } },
      { userEmail: 'admin@example.com' },
    );
    expect(after.thresholds.anomalyScore).toBe(0.95);
    expect(after.thresholds.pendingTimeoutSec).toBe(
      before.thresholds.pendingTimeoutSec,
    );
    expect(after.retention.days).toBe(before.retention.days);
    expect(after.deploymentMode).toBe('custom');
  });

  test('records updatedBy from user email', () => {
    const { service } = makeService();
    service.seedDefaults();
    const after = service.update(
      'default',
      { thresholds: { anomalyScore: 0.7 } },
      { userEmail: 'someone@example.com' },
    );
    expect(after.updatedBy).toBe('someone@example.com');
    expect(after.updatedAt).toBeDefined();
  });

  test('rejects update with invalid types via Zod', () => {
    const { service } = makeService();
    service.seedDefaults();
    expect(() =>
      service.update(
        'default',
        { thresholds: { anomalyScore: 'not-a-number' as any } },
        {},
      ),
    ).toThrow();
  });
});

describe('TenantConfigService.replace', () => {
  test('full replace stores exactly the provided config', () => {
    const { service } = makeService();
    service.seedDefaults();
    const dev = service.getTemplate('dev')!.config;
    const after = service.replace('default', dev, { userEmail: 'me' });
    expect(after.deploymentMode).toBe('dev');
    expect(after.layers.l2.enabled).toBe(false);
    expect(after.layers.l3.enabled).toBe(false);
  });
});

describe('Cross-tenant isolation', () => {
  test('updates to org A do not affect org B', () => {
    const { db, service } = makeService();
    db.prepare(
      `INSERT INTO organizations (id, name, slug, plan) VALUES (?, ?, ?, ?)`,
    ).run('org-b', 'Org B', 'org-b', 'enterprise');
    service.seedDefaults();

    service.applyTemplate('default', 'financial', {});
    service.applyTemplate('org-b', 'dev', {});

    expect(service.get('default').deploymentMode).toBe('financial');
    expect(service.get('org-b').deploymentMode).toBe('dev');
  });
});

describe('Audit log integration', () => {
  test('every mutating call writes an admin_audit_log row', () => {
    const { db, service } = makeService();
    service.seedDefaults();
    service.applyTemplate('default', 'strict', { userEmail: 'a@b.c' });
    service.update(
      'default',
      { thresholds: { anomalyScore: 0.5 } },
      { userEmail: 'a@b.c' },
    );

    const rows = db
      .prepare(
        `SELECT action FROM admin_audit_log WHERE action LIKE 'tenant.config%' ORDER BY id`,
      )
      .all() as { action: string }[];
    // seedDefaults itself does NOT log (it bypasses the audit layer); the two
    // explicit calls each produce one entry.
    expect(rows.map((r) => r.action)).toEqual([
      'tenant.config.apply-template',
      'tenant.config.update',
    ]);
  });
});

describe('ConfigBus', () => {
  test('onConfigChange returns a working unsubscribe', () => {
    const bus = new ConfigBus(silentLogger);
    const seen: ConfigEvent[] = [];
    const unsub = bus.onConfigChange((e) => seen.push(e));
    bus.emitConfigChange({ type: 'tenant.config.deleted', orgId: 'a' });
    unsub();
    bus.emitConfigChange({ type: 'tenant.config.deleted', orgId: 'b' });
    expect(seen).toHaveLength(1);
  });
});
