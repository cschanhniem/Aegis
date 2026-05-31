import { SinkEvent } from '@agentguard/core-schema';
import { KafkaSink, KafkaFactory } from '../sinks/built-in/kafka';
import { NatsSink, NatsFactory } from '../sinks/built-in/nats';
import { SinkRuntime } from '../sinks/runtime';

const event = (over: Partial<SinkEvent> = {}): SinkEvent => ({
  kind: 'audit',
  tenantId: 'default',
  timestamp: '2026-05-31T00:00:00Z',
  payload: { action: 'policy.create', resource_type: 'policy', resource_id: 'p_42' },
  ...over,
});

// ── KafkaSink ──────────────────────────────────────────────────────────

describe('KafkaSink', () => {
  it('publishes the mapped payload to the configured topic', async () => {
    const sent: any[] = [];
    const factory: KafkaFactory = () => ({
      async send(msg) { sent.push(msg); },
      async disconnect() {},
    });
    const sink = new KafkaSink({
      kind: 'kafka', name: 'audit-stream', enabled: true,
      brokers: ['broker:9092'], topic: 'aegis.audit',
      clientId: 'aegis-sink',
      fieldMapping: { event_type: '${event.kind}', action: '${event.payload.action}' },
      retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 1000,
    }, factory);
    const r = await sink.send(event());
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe('aegis.audit');
    expect(JSON.parse(sent[0].messages[0].value)).toEqual({
      event_type: 'audit', action: 'policy.create',
    });
  });

  it('uses keyPath to derive Kafka message key', async () => {
    const sent: any[] = [];
    const factory: KafkaFactory = () => ({
      async send(msg) { sent.push(msg); },
      async disconnect() {},
    });
    const sink = new KafkaSink({
      kind: 'kafka', name: 's', enabled: true,
      brokers: ['b:9092'], topic: 't',
      clientId: 'c',
      keyPath: 'event.payload.resource_id',
      retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 1000,
    }, factory);
    await sink.send(event());
    expect(sent[0].messages[0].key).toBe('p_42');
  });

  it('retries on transient errors and reports success on retry', async () => {
    let calls = 0;
    const factory: KafkaFactory = () => ({
      async send() { calls++; if (calls < 2) throw new Error('NETWORK_DOWN'); },
      async disconnect() {},
    });
    const sink = new KafkaSink({
      kind: 'kafka', name: 's', enabled: true,
      brokers: ['b:9092'], topic: 't', clientId: 'c',
      retry: { maxAttempts: 3, backoffMs: 1, factor: 1 }, timeoutMs: 1000,
    }, factory);
    const r = await sink.send(event());
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it('reports failure after max attempts exhausted', async () => {
    const factory: KafkaFactory = () => ({
      async send() { throw new Error('BOOM'); },
      async disconnect() {},
    });
    const sink = new KafkaSink({
      kind: 'kafka', name: 's', enabled: true,
      brokers: ['b:9092'], topic: 't', clientId: 'c',
      retry: { maxAttempts: 2, backoffMs: 1, factor: 1 }, timeoutMs: 1000,
    }, factory);
    const r = await sink.send(event());
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.error).toMatch(/BOOM/);
  });
});

// ── NatsSink ───────────────────────────────────────────────────────────

describe('NatsSink', () => {
  it('publishes mapped payload to the subject', async () => {
    const sent: Array<[string, string]> = [];
    const factory: NatsFactory = () => ({
      async publish(subject, payload) { sent.push([subject, payload]); },
      async close() {},
    });
    const sink = new NatsSink({
      kind: 'nats', name: 'stream-1', enabled: true,
      servers: ['nats://localhost:4222'],
      subject: 'aegis.events',
      fieldMapping: { action: '${event.payload.action}' },
      retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 1000,
    }, factory);
    const r = await sink.send(event());
    expect(r.ok).toBe(true);
    expect(sent[0][0]).toBe('aegis.events');
    expect(JSON.parse(sent[0][1])).toEqual({ action: 'policy.create' });
  });

  it('retries on transient publish failure', async () => {
    let calls = 0;
    const factory: NatsFactory = () => ({
      async publish() { calls++; if (calls < 3) throw new Error('NOT_READY'); },
      async close() {},
    });
    const sink = new NatsSink({
      kind: 'nats', name: 'n', enabled: true,
      servers: ['nats://x:4222'], subject: 's',
      retry: { maxAttempts: 5, backoffMs: 1, factor: 1 }, timeoutMs: 1000,
    }, factory);
    const r = await sink.send(event());
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });
});

// ── Runtime integration ────────────────────────────────────────────────

describe('SinkRuntime instantiates kafka + nats kinds', () => {
  it('fans an event out across http + kafka + nats sinks at once', async () => {
    const sentKafka: any[] = [];
    const sentNats: Array<[string, string]> = [];
    // Inject factories via the module-level setters.
    const { setDefaultKafkaFactory } = await import('../sinks/built-in/kafka');
    const { setDefaultNatsFactory }  = await import('../sinks/built-in/nats');
    setDefaultKafkaFactory(() => ({ async send(m) { sentKafka.push(m); }, async disconnect() {} }));
    setDefaultNatsFactory(()  => ({ async publish(s, p) { sentNats.push([s, p]); }, async close() {} }));

    const rt = new SinkRuntime();
    rt.setConfigs([
      { kind: 'stdout', name: 'debug', enabled: true } as any,
      { kind: 'kafka',  name: 'kf', enabled: true,
        brokers: ['b:9092'], topic: 'aegis', clientId: 'c',
        retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 1000 } as any,
      { kind: 'nats',   name: 'nt', enabled: true,
        servers: ['nats://x:4222'], subject: 'a',
        retry: { maxAttempts: 1, backoffMs: 0, factor: 1 }, timeoutMs: 1000 } as any,
    ]);
    const results = await rt.fanout(event());
    const okMap = Object.fromEntries(results.map(r => [r.sink, r.result.ok]));
    expect(okMap['kf']).toBe(true);
    expect(okMap['nt']).toBe(true);
    expect(sentKafka.length).toBe(1);
    expect(sentNats.length).toBe(1);
    setDefaultKafkaFactory(null);
    setDefaultNatsFactory(null);
  });
});
