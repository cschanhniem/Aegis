import Database from 'better-sqlite3';
import pino from 'pino';
import { TemplateRegistryService } from '../services/template-registry';
import { TenantConfigSchema, RESERVED_TEMPLATE_IDS } from '@agentguard/core-schema';

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE gateway_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return d;
}

function fakeConfig(over: any = {}) {
  // The minimum-viable shape TenantConfigSchema accepts (built-in template
  // standard is the shortest path to a valid object).
  return TenantConfigSchema.parse({
    version: 1,
    deploymentMode: 'standard',
    layers: { l1: { enabled: true }, l2: { enabled: true, threshold: 0.7 }, l3: { enabled: true } },
    thresholds: { anomalyScore: 0.8, pendingTimeoutSec: 300 },
    retention: { days: 90, enforcePII: false },
    policyOverrides: {},
    sinks: [], customDetectors: [], customComplianceFrameworks: [],
    ...over,
  });
}

describe('TemplateRegistryService.list', () => {
  it('returns 5 built-ins + 0 customs on fresh gateway', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    const list = reg.list();
    const byName = list.map(t => t.name as string);
    expect(byName.sort()).toEqual(['dev', 'financial', 'healthcare', 'standard', 'strict'].sort());
    expect(list.every(t => t.source === 'builtin')).toBe(true);
  });

  it('includes registered customs', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    reg.register({
      id: 'bank-prod',
      name: 'Bank Production',
      description: 'Strict layers + Splunk + per-agent budget.',
      config: fakeConfig(),
    });
    const customs = reg.list().filter(t => t.source === 'custom');
    expect(customs.length).toBe(1);
    expect(customs[0].name as string).toBe('bank-prod');
  });
});

describe('TemplateRegistryService.get', () => {
  it('returns built-in by id', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    expect(reg.get('standard')?.source).toBe('builtin');
  });

  it('returns custom by id after registration', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    reg.register({ id: 'foo-bar', name: 'Foo Bar', config: fakeConfig() });
    expect(reg.get('foo-bar')?.source).toBe('custom');
  });

  it('returns null for unknown id', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    expect(reg.get('nope')).toBeNull();
  });
});

describe('TemplateRegistryService.register', () => {
  it('rejects reserved IDs', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    for (const id of RESERVED_TEMPLATE_IDS) {
      expect(() => reg.register({ id, name: 'x', config: fakeConfig() })).toThrow(/reserved/);
    }
  });

  it('normalizes deploymentMode → custom on persisted config', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    const stored = reg.register({
      id: 'my-template',
      name: 'mine',
      config: fakeConfig({ deploymentMode: 'strict' }),
    });
    expect(stored.config.deploymentMode).toBe('custom');
  });

  it('overwrites a same-id custom template on re-register', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    reg.register({ id: 'mine', name: 'v1', description: 'first', config: fakeConfig() });
    reg.register({ id: 'mine', name: 'v2', description: 'second', config: fakeConfig() });
    expect(reg.get('mine')?.description).toBe('second');
  });
});

describe('TemplateRegistryService.delete', () => {
  it('refuses to delete built-ins', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    expect(() => reg.delete('standard')).toThrow(/built-in/);
  });

  it('removes a custom and returns true; false on unknown', () => {
    const reg = new TemplateRegistryService(db(), pino({ level: 'silent' }));
    reg.register({ id: 'mine', name: 'x', config: fakeConfig() });
    expect(reg.delete('mine')).toBe(true);
    expect(reg.delete('mine')).toBe(false);
  });
});
