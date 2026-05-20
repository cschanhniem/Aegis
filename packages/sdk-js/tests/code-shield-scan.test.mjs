/**
 * scan() helper — uses a stubbed global fetch so this runs without
 * a gateway. Verifies URL shape, headers, body, retention into the
 * closed-loop buffer, and error propagation.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeShieldScan,
  _csConsume as consume,
  _csReset as reset,
} from '../dist/index.mjs';

const originalFetch = globalThis.fetch;

function stubFetchOnce({ status = 200, body }) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  };
  return calls;
}

describe('codeShieldScan()', () => {
  beforeEach(() => {
    reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to /api/v1/code-shield/scan with the expected body', async () => {
    const calls = stubFetchOnce({
      body: {
        worst: 'CRITICAL',
        findings: [
          { rule: 'py.eval', description: 'eval', severity: 'CRITICAL', language: 'python', line: 1, column: 1, snippet: 'eval(x)' },
        ],
        unique_findings: 1,
        scanned_chars: 7,
        latency_ms: 0,
      },
    });

    const r = await codeShieldScan({
      code: 'eval(x)',
      language: 'python',
      gatewayUrl: 'http://gw.local:8080',
      apiKey: 'test-key',
      agentId: 'agent-1',
    });

    assert.equal(r.worst, 'CRITICAL');
    assert.equal(r.findings[0].rule, 'py.eval');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://gw.local:8080/api/v1/code-shield/scan');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-API-Key'], 'test-key');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.code, 'eval(x)');
    assert.equal(body.language, 'python');
    assert.equal(body.agent_id, 'agent-1');
  });

  it('buffers the result for the next /check by default', async () => {
    stubFetchOnce({
      body: { worst: 'HIGH', findings: [{ rule: 'sh.sudo' }], unique_findings: 1, scanned_chars: 8, latency_ms: 0 },
    });

    await codeShieldScan({
      code: 'sudo ls',
      language: 'shell',
      gatewayUrl: 'http://gw.local:8080',
      agentId: 'agent-buf',
    });

    const buffered = consume('agent-buf');
    assert.ok(buffered, 'expected result to be buffered');
    assert.equal(buffered.worst, 'HIGH');
  });

  it('skips buffering when recordForCheck=false', async () => {
    stubFetchOnce({
      body: { worst: 'LOW', findings: [], unique_findings: 0, scanned_chars: 0, latency_ms: 0 },
    });

    await codeShieldScan({
      code: 'noop',
      gatewayUrl: 'http://gw.local:8080',
      agentId: 'agent-no-buf',
      recordForCheck: false,
    });

    assert.equal(consume('agent-no-buf'), null);
  });

  it('rejects unknown languages', async () => {
    await assert.rejects(
      () =>
        codeShieldScan({
          code: 'x',
          // @ts-expect-error — intentional bad input
          language: 'cobol',
          gatewayUrl: 'http://gw.local:8080',
        }),
      /language must be one of/,
    );
  });

  it('throws on non-2xx responses', async () => {
    stubFetchOnce({ status: 400, body: { error: 'bad input' } });
    await assert.rejects(
      () => codeShieldScan({ code: 'x', gatewayUrl: 'http://gw.local:8080' }),
      /HTTP 400/,
    );
  });

  it('does not send X-API-Key when no key is configured', async () => {
    // Clear any env-level key for the duration.
    const prev = process.env.AEGIS_API_KEY;
    delete process.env.AEGIS_API_KEY;
    try {
      const calls = stubFetchOnce({
        body: { worst: null, findings: [], unique_findings: 0, scanned_chars: 0, latency_ms: 0 },
      });
      await codeShieldScan({ code: 'noop', gatewayUrl: 'http://gw.local:8080' });
      assert.equal(calls[0].init.headers['X-API-Key'], undefined);
    } finally {
      if (prev !== undefined) process.env.AEGIS_API_KEY = prev;
    }
  });
});
