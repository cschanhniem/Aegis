/**
 * Compliance evidence API tests.
 *
 * Pins the auditor-facing contract:
 *   - /manifest enumerates bundle types
 *   - Each bundle returns the documented shape
 *   - PII (email local-parts) is redacted in user dumps
 *   - org_id filter scopes results
 *   - Missing-table fallbacks are graceful (note, not crash)
 *   - Cardinality is bounded (limit ≤ 5000)
 */
import express from 'express';
import http from 'http';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ComplianceEvidenceAPI } from '../api/compliance-evidence';
import { GatewayMetricsService } from '../services/gateway-metrics';
import { PolicyEngine } from '../policies/policy-engine';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE policies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      policy_schema TEXT NOT NULL, risk_level TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      org_id TEXT NOT NULL DEFAULT '*'
    );
    INSERT INTO policies (id, name, description, policy_schema, risk_level, org_id)
      VALUES ('sql-injection', 'SQL Injection Prevention', '', '{}', 'HIGH', '*');

    CREATE TABLE users (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL,
      role TEXT NOT NULL, last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'active'
    );
    INSERT INTO users (id, org_id, email, role, status) VALUES
      ('u1', 'acme', 'alice@acme.com',   'admin',   'active'),
      ('u2', 'acme', 'bob@acme.com',     'auditor', 'active'),
      ('u3', 'beta', 'carol@beta.io',    'admin',   'active'),
      ('u4', 'acme', 'olduser@acme.com', 'viewer',  'disabled');

    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL, org_id TEXT NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT, source_ip TEXT
    );
    INSERT INTO audit_log (timestamp, org_id, actor, action, resource_type, resource_id, source_ip) VALUES
      ('2026-06-01T10:00:00Z', 'acme', 'alice@acme.com', 'policy.update',   'policy', 'sql-injection', '10.0.0.1'),
      ('2026-06-02T11:00:00Z', 'acme', 'alice@acme.com', 'tenant.config.update', 'tenant_config', 'acme', '10.0.0.1'),
      ('2026-06-02T12:00:00Z', 'beta', 'carol@beta.io',  'user.deactivate', 'user',   'u-99',         '10.0.0.2'),
      ('2026-06-03T09:00:00Z', 'acme', 'alice@acme.com', 'check.allow',     'trace',  'tr-abc',       '10.0.0.1');

    CREATE TABLE anomaly_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL, agent_id TEXT NOT NULL,
      score REAL NOT NULL, decision TEXT NOT NULL, signal_count INTEGER NOT NULL
    );
    INSERT INTO anomaly_events (created_at, agent_id, score, decision, signal_count) VALUES
      ('2026-06-01T10:00:00Z', 'agent-1', 0.85, 'escalate', 3),
      ('2026-06-02T11:00:00Z', 'agent-2', 0.95, 'block',    5);

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    INSERT INTO sessions VALUES
      ('s1', '2026-06-03T08:00:00Z', '2030-06-03T08:00:00Z'),
      ('s2', '2026-06-03T07:00:00Z', '2030-06-03T08:00:00Z');
  `);
  return db;
}

const logger = pino({ level: 'silent' });

async function startServer(): Promise<{ server: http.Server; baseUrl: string; engine: PolicyEngine; metrics: GatewayMetricsService }> {
  const db = makeDb();
  const engine = new PolicyEngine(db, logger);
  const metrics = new GatewayMetricsService();
  metrics.recordCheck('allow', 'acme');
  metrics.setDlqDepth('acme', 0);
  const app = express();
  app.use('/api/v1/compliance', new ComplianceEvidenceAPI(db, logger, metrics, engine).router);
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const addr = server.address() as any;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, engine, metrics };
}

async function fetchJson(url: string): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const u = new URL(url);
    http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : null }));
    }).on('error', reject).end();
  });
}

describe('ComplianceEvidenceAPI — manifest', () => {
  let h: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => new Promise<void>(r => h.server.close(() => r())));

  test('manifest enumerates every supported bundle type', async () => {
    const { status, body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence/manifest`);
    expect(status).toBe(200);
    expect(body.version).toBe(1);
    const types = body.bundle_types.map((b: any) => b.type);
    expect(types).toEqual(expect.arrayContaining([
      'users', 'roles', 'audit-log', 'changes', 'incidents', 'vendors',
      'anomalies', 'monitoring', 'policies', 'sessions', 'access-review',
    ]));
    // Each entry must name a control so the auditor knows what it's for.
    for (const b of body.bundle_types) expect(b.control).toBeDefined();
  });
});

describe('ComplianceEvidenceAPI — bundles', () => {
  let h: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => new Promise<void>(r => h.server.close(() => r())));

  test('users — emails are redacted (PII)', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=users&limit=10`);
    expect(body.type).toBe('users');
    expect(body.total).toBe(4);
    for (const r of body.rows) {
      expect(r.email).toMatch(/^\*\*\*@/);  // local-part redacted; domain preserved
      expect(r.email).not.toContain('alice');
      expect(r.email).not.toContain('bob');
    }
  });

  test('users — org_id filter scopes results', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=users&org_id=acme`);
    expect(body.total).toBe(3);
    for (const r of body.rows) expect(r.org_id).toBe('acme');
  });

  test('roles — emits the documented role list', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=roles`);
    expect(body.roles.map((r: any) => r.role).sort()).toEqual(['admin', 'auditor', 'viewer']);
  });

  test('audit-log — returns rows with timestamp + actor + resource', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=audit-log&limit=100`);
    expect(body.total).toBe(4);
    expect(body.rows[0]).toHaveProperty('timestamp');
    expect(body.rows[0]).toHaveProperty('actor');
    expect(body.rows[0]).toHaveProperty('action');
    expect(body.rows[0]).toHaveProperty('resource_type');
  });

  test('audit-log — since / until filter the window', async () => {
    const { body } = await fetchJson(
      `${h.baseUrl}/api/v1/compliance/evidence?type=audit-log&since=2026-06-02T00:00:00Z&until=2026-06-02T23:59:59Z`,
    );
    expect(body.total).toBe(2);
    for (const r of body.rows) {
      expect(r.timestamp >= '2026-06-02').toBe(true);
      expect(r.timestamp <= '2026-06-02T23:59:59Z').toBe(true);
    }
  });

  test('changes — only emits config / policy / SSO mutations (not check rows)', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=changes&limit=100`);
    expect(body.total).toBe(2);  // policy.update + tenant.config.update; the check.allow row is excluded
    const types = body.rows.map((r: any) => r.resource_type);
    expect(types).toEqual(expect.arrayContaining(['policy', 'tenant_config']));
    expect(types).not.toContain('trace');
  });

  test('anomalies — returns score + decision per event', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=anomalies`);
    expect(body.total).toBe(2);
    for (const r of body.rows) {
      expect(typeof r.score).toBe('number');
      expect(['escalate', 'block', 'allow']).toContain(r.decision);
    }
  });

  test('monitoring — emits live Prometheus snapshot', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=monitoring`);
    expect(body.type).toBe('monitoring');
    expect(body.snapshot).toHaveProperty('counters');
    expect(body.snapshot).toHaveProperty('gauges');
    expect(body.snapshot).toHaveProperty('histograms');
  });

  test('policies — for org acme returns wildcard policy with scope label', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=policies&org_id=acme`);
    expect(body.org_id).toBe('acme');
    expect(body.rows.find((r: any) => r.id === 'sql-injection')?.scope).toBe('platform-default');
  });

  test('sessions — counts active sessions', async () => {
    const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=sessions`);
    expect(body.active_total).toBe(2);
  });

  test('vendors / access-review / incidents return documented pointers', async () => {
    for (const type of ['vendors', 'access-review', 'incidents']) {
      const { body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=${type}`);
      expect(body.type).toBe(type);
      expect(body.note ?? body.source).toBeDefined();
    }
  });

  test('rejects invalid type with 400', async () => {
    const { status, body } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=wat`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid query');
  });

  test('rejects limit > 5000 (cardinality cap)', async () => {
    const { status } = await fetchJson(`${h.baseUrl}/api/v1/compliance/evidence?type=users&limit=999999`);
    expect(status).toBe(400);
  });
});
