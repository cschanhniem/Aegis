import { SinkEvent } from '@agentguard/core-schema';
import { SinkRuntime } from '../sinks/runtime';
import { HttpSink } from '../sinks/built-in/http';
import { StdoutSink } from '../sinks/built-in/stdout';
import { applyMapping } from '../sinks/template';

// ── helpers ───────────────────────────────────────────────────────────────

const event = (over: Partial<SinkEvent> = {}): SinkEvent => ({
  kind: 'audit',
  tenantId: 'org-default',
  timestamp: '2026-05-29T00:00:00Z',
  payload: { action: 'policy.create', resource_type: 'policy', resource_id: 'p_42' },
  ...over,
});

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(impl as any);
}

afterEach(() => jest.restoreAllMocks());

// ── template engine ───────────────────────────────────────────────────────

describe('applyMapping', () => {
  it('passes the raw event through when no mapping is supplied', () => {
    const out = applyMapping(event(), undefined);
    expect(out.action).toBe('policy.create');
    expect(out.tenantId).toBe('org-default');
  });

  it('interpolates ${event.path.to.field} references', () => {
    const out = applyMapping(event(), {
      message: 'tenant ${event.tenantId} did ${event.payload.action}',
      kind: '${event.kind}',
    });
    expect(out.message).toBe('tenant org-default did policy.create');
    expect(out.kind).toBe('audit');
  });

  it('resolves missing paths to empty string (not undefined)', () => {
    const out = applyMapping(event(), { foo: 'pre-${event.does.not.exist}-post' });
    expect(out.foo).toBe('pre--post');
  });
});

// ── HttpSink ──────────────────────────────────────────────────────────────

describe('HttpSink', () => {
  it('POSTs the mapped payload + custom headers + auth', async () => {
    const captured: { url: string; init: RequestInit } = { url: '', init: {} };
    mockFetch(async (url, init) => {
      captured.url = url;
      captured.init = init;
      return new Response('{}', { status: 200 });
    });

    const sink = new HttpSink({
      kind: 'http', name: 'splunk-prod', enabled: true,
      url: 'https://splunk.example.com/services/collector',
      method: 'POST',
      headers: { 'X-Source': 'aegis' },
      authHeader: 'Splunk hec-token-redacted',
      fieldMapping: { event: '${event.payload.action}', sourcetype: 'aegis_audit' },
      retry: { maxAttempts: 1, backoffMs: 0, factor: 2 },
      timeoutMs: 1000,
    });

    const result = await sink.send(event());
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(captured.url).toBe('https://splunk.example.com/services/collector');
    const headers = captured.init.headers as Record<string, string>;
    expect(headers['X-Source']).toBe('aegis');
    expect(headers.authorization).toBe('Splunk hec-token-redacted');
    expect(JSON.parse(captured.init.body as string)).toEqual({
      event: 'policy.create', sourcetype: 'aegis_audit',
    });
  });

  it('retries on 5xx and reports success on the retry', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return calls < 2
        ? new Response('upstream down', { status: 503 })
        : new Response('{}', { status: 200 });
    });
    const sink = new HttpSink({
      kind: 'http', name: 's', enabled: true,
      url: 'https://example.com/x', method: 'POST', headers: {},
      retry: { maxAttempts: 3, backoffMs: 1, factor: 1 },
      timeoutMs: 500,
    });
    const r = await sink.send(event());
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it('does NOT retry on 400 (non-retryable client error)', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return new Response('bad payload', { status: 400 });
    });
    const sink = new HttpSink({
      kind: 'http', name: 's', enabled: true,
      url: 'https://example.com/x', method: 'POST', headers: {},
      retry: { maxAttempts: 5, backoffMs: 1, factor: 1 },
      timeoutMs: 500,
    });
    const r = await sink.send(event());
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(r.status).toBe(400);
  });

  it('DOES retry on 429 + 408 (retryable client errors)', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return calls < 3 ? new Response('rate limited', { status: 429 }) : new Response('{}', { status: 200 });
    });
    const sink = new HttpSink({
      kind: 'http', name: 's', enabled: true,
      url: 'https://example.com/x', method: 'POST', headers: {},
      retry: { maxAttempts: 5, backoffMs: 1, factor: 1 },
      timeoutMs: 500,
    });
    const r = await sink.send(event());
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });
});

// ── SinkRuntime + fan-out + DLQ ───────────────────────────────────────────

describe('SinkRuntime', () => {
  it('fans an event out to every enabled sink', async () => {
    mockFetch(async () => new Response('{}', { status: 200 }));
    const rt = new SinkRuntime();
    rt.setConfigs([
      { kind: 'http', name: 'a', enabled: true, url: 'https://a.example.com', method: 'POST', headers: {}, retry: { maxAttempts: 1, backoffMs: 0, factor: 2 }, timeoutMs: 500 },
      { kind: 'http', name: 'b', enabled: true, url: 'https://b.example.com', method: 'POST', headers: {}, retry: { maxAttempts: 1, backoffMs: 0, factor: 2 }, timeoutMs: 500 },
      { kind: 'stdout', name: 'debug', enabled: true },
    ]);
    const results = await rt.fanout(event());
    const names = results.map(r => r.sink).sort();
    expect(names).toEqual(['a', 'b', 'debug']);
    expect(results.every(r => r.result.ok)).toBe(true);
  });

  it('disabled sinks do not load', () => {
    const rt = new SinkRuntime();
    rt.setConfigs([
      { kind: 'stdout', name: 'one', enabled: true },
      { kind: 'stdout', name: 'two', enabled: false },
    ]);
    expect(rt.list().map(s => s.name).sort()).toEqual(['one']);
  });

  it('DLQ accumulates failed events', async () => {
    mockFetch(async () => new Response('boom', { status: 500 }));
    const rt = new SinkRuntime();
    rt.setConfigs([
      { kind: 'http', name: 'doomed', enabled: true, url: 'https://x.example.com', method: 'POST', headers: {}, retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 200 },
    ]);
    await rt.fanout(event());
    await rt.fanout(event());
    expect(rt.dlqDepth('doomed')).toBe(2);
    const m = rt.getMetrics('doomed')!;
    expect(m.failed).toBe(2);
    expect(m.sent).toBe(0);
  });

  it('one sink failure does not block other sinks', async () => {
    mockFetch(async (url) => {
      if (String(url).includes('a.example.com')) return new Response('boom', { status: 500 });
      return new Response('{}', { status: 200 });
    });
    const rt = new SinkRuntime();
    rt.setConfigs([
      { kind: 'http', name: 'a', enabled: true, url: 'https://a.example.com', method: 'POST', headers: {}, retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 200 },
      { kind: 'http', name: 'b', enabled: true, url: 'https://b.example.com', method: 'POST', headers: {}, retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 200 },
    ]);
    const results = await rt.fanout(event());
    const okMap = new Map(results.map(r => [r.sink, r.result.ok]));
    expect(okMap.get('a')).toBe(false);
    expect(okMap.get('b')).toBe(true);
  });

  it('setConfigs replaces the live sink set', () => {
    const rt = new SinkRuntime();
    rt.setConfigs([
      { kind: 'stdout', name: 'one', enabled: true },
      { kind: 'stdout', name: 'two', enabled: true },
    ]);
    expect(rt.list().length).toBe(2);
    rt.setConfigs([{ kind: 'stdout', name: 'three', enabled: true }]);
    expect(rt.list().map(s => s.name)).toEqual(['three']);
  });
});

// ── StdoutSink (smoke) ────────────────────────────────────────────────────

describe('StdoutSink', () => {
  it('writes one JSON line and reports success', async () => {
    const writes: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    const sink = new StdoutSink({ kind: 'stdout', name: 'debug', enabled: true });
    const r = await sink.send(event());
    expect(r.ok).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatch(/policy\.create/);
  });
});
