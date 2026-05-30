import Database from 'better-sqlite3';
import pino from 'pino';
import { OtlpExporterService } from '../services/otlp-exporter';
import { TenantConfigService } from '../services/tenant-config';
import { ConfigBus } from '../services/config-bus';
import { AuditLogService } from '../services/audit-log';
import { convertRowToSpan, buildExportRequest, AegisTraceRow } from '../services/otlp-convert';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, plan TEXT,
      settings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, user_id TEXT, user_email TEXT,
      action TEXT, resource_type TEXT, resource_id TEXT,
      details TEXT, ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      parent_trace_id TEXT,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      input_context TEXT, thought_chain TEXT,
      tool_call TEXT NOT NULL, observation TEXT,
      integrity_hash TEXT NOT NULL,
      safety_validation TEXT,
      environment TEXT NOT NULL,
      version TEXT NOT NULL,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
      session_id TEXT, pii_detected INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gateway_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO organizations (id, name, slug, plan) VALUES ('default', 'd', 'd', 'community');
  `);
  const logger = pino({ level: 'silent' });
  const audit = new AuditLogService(db, logger);
  const bus = new ConfigBus(logger);
  const tc = new TenantConfigService(db, logger, bus, audit);
  tc.seedDefaults();
  const exp = new OtlpExporterService(db, logger, tc, bus);
  return { db, tc, exp };
}

function seedTrace(db: Database.Database, id: number, override: Partial<AegisTraceRow> = {}) {
  const row: any = {
    trace_id: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`,
    parent_trace_id: null,
    agent_id: 'agent-1',
    timestamp: new Date('2026-05-29T12:00:00Z').toISOString(),
    sequence_number: id,
    tool_call: JSON.stringify({ tool_name: 'web_search', function: 'search', arguments: { q: 'hi' } }),
    observation: JSON.stringify({ duration_ms: 120 }),
    safety_validation: JSON.stringify({ passed: true, risk_level: 'LOW', policy_name: 'default' }),
    integrity_hash: 'h',
    environment: 'DEVELOPMENT',
    version: '1.0.0',
    model: 'gpt-4',
    input_tokens: 20,
    output_tokens: 5,
    cost_usd: 0.001,
    session_id: 'sess-1',
    pii_detected: 0,
    ...override,
  };
  db.prepare(
    `INSERT INTO traces (trace_id, parent_trace_id, agent_id, timestamp, sequence_number,
                         tool_call, observation, safety_validation, integrity_hash,
                         environment, version, model, input_tokens, output_tokens, cost_usd,
                         session_id, pii_detected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.trace_id, row.parent_trace_id, row.agent_id, row.timestamp, row.sequence_number,
    row.tool_call, row.observation, row.safety_validation, row.integrity_hash,
    row.environment, row.version, row.model, row.input_tokens, row.output_tokens, row.cost_usd,
    row.session_id, row.pii_detected,
  );
}

afterEach(() => jest.restoreAllMocks());

// ── Converter (pure) ──────────────────────────────────────────────────────

describe('convertRowToSpan', () => {
  it('UUID → 32-hex traceId; first 16 hex → spanId', () => {
    const row: AegisTraceRow = {
      trace_id: 'aabbccdd-1122-3344-5566-778899001122',
      agent_id: 'agent-1',
      timestamp: '2026-05-29T00:00:00.000Z',
      tool_call: '{"tool_name":"foo"}',
    };
    const span = convertRowToSpan(row);
    expect(span.traceId).toBe('aabbccdd112233445566778899001122');
    expect(span.spanId).toBe('aabbccdd11223344');
  });

  it('sets endTimeUnixNano = startTimeUnixNano + duration_ms * 1e6', () => {
    const start = '2026-05-29T00:00:00.000Z';
    const startMs = Date.parse(start);
    const row: AegisTraceRow = {
      trace_id: 'aabbccdd-1122-3344-5566-778899001122',
      agent_id: 'a',
      timestamp: start,
      tool_call: '{"tool_name":"foo"}',
      observation: JSON.stringify({ duration_ms: 250 }),
    };
    const span = convertRowToSpan(row);
    const startNs = BigInt(startMs) * 1_000_000n;
    const endNs = startNs + 250n * 1_000_000n;
    expect(span.startTimeUnixNano).toBe(startNs.toString());
    expect(span.endTimeUnixNano).toBe(endNs.toString());
  });

  it("status.code=2 (ERROR) when safety_validation.passed=false", () => {
    const row: AegisTraceRow = {
      trace_id: 'aabbccdd-1122-3344-5566-778899001122',
      agent_id: 'a',
      timestamp: '2026-05-29T00:00:00.000Z',
      tool_call: '{"tool_name":"foo"}',
      safety_validation: JSON.stringify({ passed: false, risk_level: 'HIGH', violations: ['drop_table'] }),
    };
    const span = convertRowToSpan(row);
    expect(span.status.code).toBe(2);
    const violations = span.attributes.find(a => a.key === 'aegis.policy.violations');
    expect(violations).toBeDefined();
  });

  it('attributes carry agent, tool, model, tokens, cost', () => {
    const row: AegisTraceRow = {
      trace_id: 'aabbccdd-1122-3344-5566-778899001122',
      agent_id: 'a-1',
      session_id: 'sess-1',
      timestamp: '2026-05-29T00:00:00.000Z',
      tool_call: '{"tool_name":"web_search"}',
      model: 'gpt-4',
      input_tokens: 10,
      output_tokens: 2,
      cost_usd: 0.0005,
    };
    const span = convertRowToSpan(row);
    const byKey = Object.fromEntries(span.attributes.map(a => [a.key, a.value]));
    expect((byKey['aegis.agent_id'] as any).stringValue).toBe('a-1');
    expect((byKey['aegis.session_id'] as any).stringValue).toBe('sess-1');
    expect((byKey['aegis.tool'] as any).stringValue).toBe('web_search');
    expect((byKey['llm.model'] as any).stringValue).toBe('gpt-4');
    expect((byKey['llm.tokens.input'] as any).intValue).toBe('10');
    expect((byKey['llm.tokens.output'] as any).intValue).toBe('2');
    expect((byKey['aegis.cost_usd'] as any).doubleValue).toBeCloseTo(0.0005);
  });

  it('parentSpanId derives from parent_trace_id when present', () => {
    const row: AegisTraceRow = {
      trace_id: 'aabbccdd-1122-3344-5566-778899001122',
      parent_trace_id: '11112222-3333-4444-5555-666677778888',
      agent_id: 'a',
      timestamp: '2026-05-29T00:00:00.000Z',
      tool_call: '{}',
    };
    const span = convertRowToSpan(row);
    expect(span.parentSpanId).toBe('1111222233334444');
  });
});

describe('buildExportRequest', () => {
  it('wraps spans in resourceSpans with service.name + tenant namespace', () => {
    const row: AegisTraceRow = {
      trace_id: 'aabbccdd-1122-3344-5566-778899001122',
      agent_id: 'a',
      timestamp: '2026-05-29T00:00:00.000Z',
      tool_call: '{"tool_name":"foo"}',
    };
    const req = buildExportRequest([row], { serviceName: 'aegis-prod', tenantId: 'acme' });
    expect(req.resourceSpans).toHaveLength(1);
    const resource = req.resourceSpans[0].resource.attributes;
    const byKey = Object.fromEntries(resource.map(a => [a.key, a.value]));
    expect((byKey['service.name'] as any).stringValue).toBe('aegis-prod');
    expect((byKey['service.namespace'] as any).stringValue).toBe('acme');
    expect(req.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  });
});

// ── Exporter (service) ────────────────────────────────────────────────────

function mockOtlpFetch(impl: (url: string, init: RequestInit) => Promise<Response>): jest.SpyInstance {
  const realFetch = globalThis.fetch.bind(globalThis);
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url.includes('otlp-collector') || url.includes('honeycomb') || url.includes('datadoghq')) {
      return impl(url, init ?? {});
    }
    return realFetch(input, init);
  });
}

describe('OtlpExporterService', () => {
  it('does nothing when otlp is disabled', async () => {
    const { exp } = setup();
    const r = await exp.tick('default');
    expect(r.exported).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('exports new trace rows + advances cursor on success', async () => {
    const { db, tc, exp } = setup();
    let posted: any[] = [];
    mockOtlpFetch(async (_url, init) => {
      posted.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    tc.update('default', {
      observability: {
        otlp: {
          enabled: true,
          endpoint: 'https://otlp-collector.example.com/v1/traces',
          headers: { 'x-honeycomb-team': 'tk-test' },
          intervalSec: 30, batchSize: 100, serviceName: 'aegis-test',
        },
      },
    }, { userEmail: 't' });
    seedTrace(db, 1);
    seedTrace(db, 2);
    seedTrace(db, 3);

    const r = await exp.tick('default');
    expect(r.exported).toBe(3);
    expect(r.ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0].resourceSpans[0].scopeSpans[0].spans).toHaveLength(3);

    // Cursor should now be at id=3; second tick exports nothing.
    const second = await exp.tick('default');
    expect(second.exported).toBe(0);
  });

  it('does NOT advance cursor when endpoint returns non-2xx', async () => {
    const { db, tc, exp } = setup();
    mockOtlpFetch(async () => new Response('upstream down', { status: 503 }));
    tc.update('default', {
      observability: {
        otlp: { enabled: true, endpoint: 'https://otlp-collector.example.com/v1/traces',
                headers: {}, intervalSec: 30, batchSize: 100, serviceName: 'aegis' },
      },
    }, { userEmail: 't' });
    seedTrace(db, 1);
    seedTrace(db, 2);

    const r1 = await exp.tick('default');
    expect(r1.ok).toBe(false);
    expect(r1.exported).toBe(0);
    expect(r1.error).toMatch(/503/);
    // Cursor stays at 0; retry should re-attempt the same batch.
    expect(exp.status('default').cursor).toBe(0);
  });

  it('honors batchSize', async () => {
    const { db, tc, exp } = setup();
    let calls = 0;
    mockOtlpFetch(async () => { calls++; return new Response('{}', { status: 200 }); });
    tc.update('default', {
      observability: {
        otlp: { enabled: true, endpoint: 'https://otlp-collector.example.com/v1/traces',
                headers: {}, intervalSec: 30, batchSize: 2, serviceName: 'aegis' },
      },
    }, { userEmail: 't' });
    seedTrace(db, 1); seedTrace(db, 2); seedTrace(db, 3); seedTrace(db, 4); seedTrace(db, 5);

    const r1 = await exp.tick('default');
    expect(r1.exported).toBe(2);
    const r2 = await exp.tick('default');
    expect(r2.exported).toBe(2);
    const r3 = await exp.tick('default');
    expect(r3.exported).toBe(1);
    expect(calls).toBe(3);
    expect(exp.status('default').cursor).toBe(5);
  });

  it('forwards custom headers (Datadog/Honeycomb API keys)', async () => {
    const { db, tc, exp } = setup();
    let capturedHeaders: any = {};
    mockOtlpFetch(async (_url, init) => {
      capturedHeaders = init.headers;
      return new Response('{}', { status: 200 });
    });
    tc.update('default', {
      observability: {
        otlp: { enabled: true, endpoint: 'https://otlp-collector.example.com/v1/traces',
                headers: { 'x-honeycomb-team': 'hc-tk', 'x-honeycomb-dataset': 'agents' },
                intervalSec: 30, batchSize: 100, serviceName: 'aegis' },
      },
    }, { userEmail: 't' });
    seedTrace(db, 1);
    await exp.tick('default');
    expect(capturedHeaders['x-honeycomb-team']).toBe('hc-tk');
    expect(capturedHeaders['x-honeycomb-dataset']).toBe('agents');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });
});
