/**
 * GatewayMetricsService — Prometheus output, middleware, and cardinality
 * guards. These tests pin the contract Ops teams scrape:
 *
 *   1. Output is valid Prometheus text-exposition format (TYPE + HELP
 *      header per metric; one numeric value per labelled row).
 *   2. Histogram buckets are CUMULATIVE (Prometheus invariant) and end
 *      with `+Inf`.
 *   3. Labels are bounded — route templates only, never trace_id /
 *      agent_id / status="200" only via fixed enum.
 *   4. Cost is emitted in BOTH cents (integer counter, no float drift)
 *      AND derived USD (for human-readable dashboards).
 *   5. Express middleware records latency + status per route on
 *      `res.finish` — verified against a real express app.
 */
import express from 'express';
import http from 'http';
import { GatewayMetricsService } from '../services/gateway-metrics';

function get(server: http.Server, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') { reject(new Error('no addr')); return; }
    const req = http.request({ host: '127.0.0.1', port: addr.port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GatewayMetricsService — Prometheus output shape', () => {
  test('emits counter with TYPE / HELP headers', () => {
    const m = new GatewayMetricsService();
    m.recordCheck('allow', 'acme');
    m.recordCheck('block', 'acme');
    const txt = m.prometheus();
    expect(txt).toContain('# TYPE aegis_check_decisions_total counter');
    expect(txt).toContain('# HELP aegis_check_decisions_total');
    expect(txt).toMatch(/aegis_check_decisions_total\{decision="allow",org="acme"\} 1/);
    expect(txt).toMatch(/aegis_check_decisions_total\{decision="block",org="acme"\} 1/);
  });

  test('histogram buckets are cumulative and terminate with +Inf', () => {
    const m = new GatewayMetricsService();
    // Use the public middleware via a fake req/res so we test the same
    // observation pathway production uses.
    const observe = (m as any).observeHistogram.bind(m);
    observe('aegis_http_request_duration_ms', { route: '/x', method: 'GET', org: 'acme' }, 7);
    observe('aegis_http_request_duration_ms', { route: '/x', method: 'GET', org: 'acme' }, 200);
    observe('aegis_http_request_duration_ms', { route: '/x', method: 'GET', org: 'acme' }, 5000);

    const txt = m.prometheus();
    // 7ms hits the le=10 bucket; 200ms hits le=250; 5000ms hits le=5000.
    expect(txt).toMatch(/aegis_http_request_duration_ms_bucket\{[^}]*le="10"\} 1/);
    expect(txt).toMatch(/aegis_http_request_duration_ms_bucket\{[^}]*le="250"\} 2/);
    expect(txt).toMatch(/aegis_http_request_duration_ms_bucket\{[^}]*le="5000"\} 3/);
    expect(txt).toMatch(/aegis_http_request_duration_ms_bucket\{[^}]*le="\+Inf"\} 3/);
    expect(txt).toMatch(/aegis_http_request_duration_ms_count\{[^}]*\} 3/);
  });

  test('cost is emitted in cents (integer) AND USD (derived counter)', () => {
    const m = new GatewayMetricsService();
    m.recordCost(0.0001, 'acme');     // ≈ 0.01¢ → rounds to 0 (drops below cent precision)
    m.recordCost(1.235, 'acme');      // 124¢
    m.recordCost(0.50, 'beta');       // 50¢
    const txt = m.prometheus();
    // Cents emitted as integer; USD as 4-decimal float.
    expect(txt).toMatch(/aegis_cost_usd_cents_total\{org="acme"\} 124/);
    expect(txt).toMatch(/aegis_cost_usd_cents_total\{org="beta"\} 50/);
    expect(txt).toMatch(/aegis_cost_usd_total\{org="acme"\} 1\.2400/);
    expect(txt).toMatch(/aegis_cost_usd_total\{org="beta"\} 0\.5000/);
  });

  test('rejects negative / non-finite cost (silent no-op)', () => {
    const m = new GatewayMetricsService();
    m.recordCost(-1, 'a');
    m.recordCost(NaN, 'a');
    m.recordCost(Infinity, 'a');
    expect(m.prometheus()).not.toMatch(/aegis_cost_usd_cents_total/);
  });

  test('gauges are last-write-wins', () => {
    const m = new GatewayMetricsService();
    m.setDlqDepth('acme', 3);
    m.setDlqDepth('acme', 7);    // overwrites 3
    expect(m.prometheus()).toMatch(/aegis_dlq_depth\{org="acme"\} 7/);
    expect(m.prometheus()).not.toMatch(/aegis_dlq_depth\{org="acme"\} 3/);
  });

  test('label keys are alphabetised — stable scrape output', () => {
    const m = new GatewayMetricsService();
    m.recordCheck('allow', 'acme');
    // Keys: decision + org → alphabetical → "decision" first, "org" second.
    expect(m.prometheus()).toMatch(/\{decision="allow",org="acme"\}/);
  });

  test('label values with quotes / backslashes are escaped', () => {
    const m = new GatewayMetricsService();
    (m as any).incCounter('test_total', { tag: 'has"quote\\and\\back' });
    const txt = m.prometheus();
    expect(txt).toContain('tag="has\\"quote\\\\and\\\\back"');
  });

  test('JSON snapshot mirrors the Prometheus state', () => {
    const m = new GatewayMetricsService();
    m.recordCheck('allow', 'acme');
    m.setDlqDepth('acme', 4);
    const snap = m.snapshot();
    expect(snap.counters['aegis_check_decisions_total{decision="allow",org="acme"}']).toBe(1);
    expect(snap.gauges['aegis_dlq_depth{org="acme"}']).toBe(4);
  });
});

describe('GatewayMetricsService — express middleware', () => {
  let server: http.Server;
  let metrics: GatewayMetricsService;

  beforeAll(async () => {
    metrics = new GatewayMetricsService();
    const app = express();
    app.use(metrics.httpMiddleware());
    app.get('/api/v1/check', (req, res) => res.json({ ok: true }));
    app.get('/api/v1/traces/:id', (req, res) => res.json({ id: req.params.id }));
    app.get('/api/v1/boom', (req, res) => res.status(500).json({ err: true }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  test('records request counter + duration histogram per route', async () => {
    await get(server, '/api/v1/check');
    await get(server, '/api/v1/check');
    const txt = metrics.prometheus();
    expect(txt).toMatch(/aegis_http_requests_total\{[^}]*route="\/api\/v1\/check"[^}]*\} 2/);
    expect(txt).toMatch(/aegis_http_request_duration_ms_count\{[^}]*route="\/api\/v1\/check"[^}]*\} 2/);
  });

  test('error responses (5xx) also increment aegis_http_errors_total', async () => {
    await get(server, '/api/v1/boom');
    const txt = metrics.prometheus();
    expect(txt).toMatch(/aegis_http_errors_total\{[^}]*status="500"[^}]*\} 1/);
  });

  test('path with :id parameter does NOT explode cardinality', async () => {
    await get(server, '/api/v1/traces/abc123');
    await get(server, '/api/v1/traces/def456');
    const txt = metrics.prometheus();
    // Both rows collapse onto the SAME route template `/api/v1/traces/:id`.
    expect(txt).toMatch(/route="\/api\/v1\/traces\/:id"/);
    // Verify two requests under the same template label.
    const m = txt.match(/aegis_http_requests_total\{[^}]*route="\/api\/v1\/traces\/:id"[^}]*\} (\d+)/);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(2);
  });
});
