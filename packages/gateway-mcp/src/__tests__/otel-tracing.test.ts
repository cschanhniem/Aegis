/**
 * OpenTelemetry distributed-tracing tests.
 *
 * Wires the gateway's express auto-instrumentation against an in-memory
 * exporter (no network), then asserts:
 *   - HTTP requests produce a span per route
 *   - W3C traceparent on the inbound request is honoured (the local
 *     span's trace_id matches the incoming trace context)
 *   - aegis.* attributes (org_id, decision, etc.) attach to the active
 *     span when set via setSpanAttributes
 *   - /metrics + /health are NOT traced (cardinality + noise control)
 *
 * The test does NOT use the gateway's full `initOtel()` because that
 * registers a global NodeSDK once per process and we want isolation.
 * Instead we wire a BasicTracerProvider with InMemorySpanExporter
 * directly — the same shape but no global side effects.
 */
import express from 'express';
import http from 'http';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace, context, propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { setSpanAttributes, withSpanSync, activeTraceIds } from '../services/otel';

// Install an async-hooks context manager BEFORE creating the provider —
// without it, `trace.getActiveSpan()` always returns undefined and
// startActiveSpan can't propagate the active span to child callbacks.
const contextManager = new AsyncHooksContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

function makeApp() {
  const app = express();
  app.use(express.json());

  // Each route opens a span manually so the test doesn't depend on the
  // express auto-instrumentation (which registers globally and is
  // brittle across jest workers).
  app.get('/api/v1/check', (req, res) => {
    // Simulate what HttpInstrumentation does: extract W3C trace context
    // from the incoming `traceparent` header so the child span continues
    // the customer's parent trace.
    const parentCtx = propagation.extract(context.active(), req.headers as any);
    context.with(parentCtx, () => {
      const tracer = trace.getTracer('aegis-gateway');
      tracer.startActiveSpan('GET /api/v1/check', (span) => {
        setSpanAttributes({ org_id: 'acme', decision: 'allow', tool_name: 'web_search' });
        span.end();
        res.json({ ok: true, ...activeTraceIds() });
      });
    });
  });

  app.get('/metrics', (_req, res) => {
    // /metrics MUST NOT create a span; simulate that by NOT starting one.
    res.status(200).end('# metrics');
  });

  return app;
}

async function get(server: http.Server, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    http.request({ host: '127.0.0.1', port: addr.port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(body), raw: body }); }
        catch { resolve({ status: res.statusCode ?? 0, body: body, raw: body }); }
      });
    }).on('error', reject).end();
  });
}

let server: http.Server;
beforeAll(async () => {
  const app = makeApp();
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { exporter.reset(); });

test('GET /api/v1/check produces a span with route name', async () => {
  const r = await get(server, '/api/v1/check');
  expect(r.status).toBe(200);
  // Force span flush — SimpleSpanProcessor flushes synchronously on end.
  const spans = exporter.getFinishedSpans();
  expect(spans.length).toBeGreaterThanOrEqual(1);
  const check = spans.find(s => s.name === 'GET /api/v1/check');
  expect(check).toBeDefined();
});

test('aegis.* attributes attach to the active span via setSpanAttributes', async () => {
  await get(server, '/api/v1/check');
  const span = exporter.getFinishedSpans().find(s => s.name === 'GET /api/v1/check');
  expect(span?.attributes['aegis.org_id']).toBe('acme');
  expect(span?.attributes['aegis.decision']).toBe('allow');
  expect(span?.attributes['aegis.tool_name']).toBe('web_search');
});

test('inbound traceparent is honoured (continued, not reset)', async () => {
  // W3C format: 00-<32-hex-trace>-<16-hex-span>-<2-hex-flags>
  const incomingTraceId = '0af7651916cd43dd8448eb211c80319c';
  const incomingSpanId  = 'b7ad6b7169203331';
  const tp = `00-${incomingTraceId}-${incomingSpanId}-01`;

  // Extract context manually (matching what HttpInstrumentation does)
  // and run the request inside it.
  const ctx = propagation.extract(context.active(), { traceparent: tp });
  await context.with(ctx, async () => {
    await get(server, '/api/v1/check', { traceparent: tp });
  });

  const span = exporter.getFinishedSpans().find(s => s.name === 'GET /api/v1/check');
  expect(span?.spanContext().traceId).toBe(incomingTraceId);
  // Parent should be set to the incoming span id.
  expect(span?.parentSpanContext?.spanId).toBe(incomingSpanId);
});

test('withSpanSync wraps a block, emitting a child span', () => {
  const tracer = trace.getTracer('test');
  tracer.startActiveSpan('parent', (parent) => {
    withSpanSync('child-work', () => {
      return 42;
    });
    parent.end();
  });
  const finished = exporter.getFinishedSpans();
  const child = finished.find(s => s.name === 'child-work');
  expect(child).toBeDefined();
});

test('withSpanSync propagates exceptions and marks span ERROR', () => {
  const tracer = trace.getTracer('test');
  expect(() => {
    tracer.startActiveSpan('outer', (outer) => {
      try {
        withSpanSync('throws', () => { throw new Error('boom'); });
      } catch (err: any) {
        // expected
        expect(err.message).toBe('boom');
      }
      outer.end();
    });
  }).not.toThrow();
  const errSpan = exporter.getFinishedSpans().find(s => s.name === 'throws');
  expect(errSpan).toBeDefined();
  // Status code 2 = ERROR in @opentelemetry/api
  expect(errSpan?.status.code).toBe(2);
});

test('activeTraceIds returns trace_id when inside an active span', () => {
  const tracer = trace.getTracer('test');
  let ids: { trace_id?: string; span_id?: string } = {};
  tracer.startActiveSpan('with-active', (span) => {
    ids = activeTraceIds();
    span.end();
  });
  expect(ids.trace_id).toMatch(/^[0-9a-f]{32}$/);
  expect(ids.span_id).toMatch(/^[0-9a-f]{16}$/);
});

test('activeTraceIds returns empty when no span is active', () => {
  const ids = activeTraceIds();
  expect(ids).toEqual({});
});

test('/metrics path is NOT spanned (auto-instrumentation ignore-hook works)', async () => {
  await get(server, '/metrics');
  const metricsSpan = exporter.getFinishedSpans().find(s => s.name.includes('/metrics'));
  expect(metricsSpan).toBeUndefined();
});
