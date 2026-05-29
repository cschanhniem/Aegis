import { Detector, DetectorContext, Signal } from '@agentguard/core-schema';
import { DetectorRegistry } from '../detectors/registry';
import { PiiDetector } from '../detectors/built-in/pii-detector';
import { ClassifierDetector } from '../detectors/built-in/classifier-detector';

const ctx = (over: Partial<DetectorContext> = {}): DetectorContext => ({
  tool: { name: 'web_search', args: { q: 'hello' } },
  agent: { id: '00000000-0000-0000-0000-000000000001' },
  tenant: { id: 'default' },
  ...over,
});

describe('DetectorRegistry', () => {
  it('registers and lists detectors', () => {
    const r = new DetectorRegistry();
    r.register(new PiiDetector());
    r.register(new ClassifierDetector());
    expect(r.list().map(d => d.name).sort()).toEqual([
      'aegis.builtin.classifier',
      'aegis.builtin.pii',
    ]);
  });

  it('refuses duplicate names', () => {
    const r = new DetectorRegistry();
    r.register(new PiiDetector());
    expect(() => r.register(new PiiDetector())).toThrow(/already registered/);
  });

  it('runs classify-kind before content-kind so upstream is populated', async () => {
    const seen: Signal[][] = [];
    const observer: Detector = {
      name: 'test.observer',
      version: '1',
      kind: 'meta',
      evaluate(c) {
        seen.push([...(c.upstream ?? [])]);
        return [];
      },
    };
    const r = new DetectorRegistry();
    r.register(observer);                  // meta runs last regardless of registration order
    r.register(new ClassifierDetector());  // classify runs first
    r.register(new PiiDetector());         // content runs second
    await r.evaluateAll(ctx({ tool: { name: 'send_email', args: { to: 'a@b.com' } } }));
    expect(seen).toHaveLength(1);
    const upstreamDetectors = new Set(seen[0].map(s => s.detector));
    expect(upstreamDetectors.has('aegis.builtin.classifier')).toBe(true);
    expect(upstreamDetectors.has('aegis.builtin.pii')).toBe(true);
  });

  it('isolates a detector that throws — chain continues', async () => {
    const r = new DetectorRegistry();
    r.register({
      name: 'test.boom',
      version: '1',
      kind: 'content',
      evaluate() { throw new Error('boom'); },
    });
    r.register(new ClassifierDetector());
    const signals = await r.evaluateAll(ctx());
    expect(signals.some(s => s.detector === 'aegis.builtin.classifier')).toBe(true);
  });

  it('isolates a detector that hangs past its timeout', async () => {
    const r = new DetectorRegistry({ perDetectorTimeoutMs: 30 });
    r.register({
      name: 'test.slow',
      version: '1',
      kind: 'content',
      evaluate() {
        return new Promise<Signal[]>(() => {});   // never resolves
      },
    });
    r.register(new ClassifierDetector());
    const signals = await r.evaluateAll(ctx());
    expect(signals.some(s => s.detector === 'test.slow')).toBe(false);
    expect(signals.some(s => s.detector === 'aegis.builtin.classifier')).toBe(true);
  });

  it('init runs once across many evaluate calls', async () => {
    let inits = 0;
    const r = new DetectorRegistry();
    r.register({
      name: 'test.init',
      version: '1',
      kind: 'content',
      init() { inits++; },
      evaluate() { return []; },
    });
    await r.evaluateAll(ctx());
    await r.evaluateAll(ctx());
    await r.evaluateAll(ctx());
    expect(inits).toBe(1);
  });
});

describe('PiiDetector', () => {
  it('emits one signal per PII type found', () => {
    const d = new PiiDetector();
    const signals = d.evaluate(ctx({
      tool: { name: 'send_email', args: { body: 'reach me at jane@acme.com or 555-867-5309' } },
    }));
    const cats = signals.map(s => s.category).sort();
    expect(cats).toContain('pii.email');
    expect(cats).toContain('pii.phone');
  });

  it('marks secret-grade PII as critical', () => {
    const d = new PiiDetector();
    const signals = d.evaluate(ctx({
      tool: {
        name: 'log',
        args: { token: 'sk-abcdefghijklmnopqrstuvwx1234567890' },
      },
    }));
    expect(signals.some(s => s.severity === 'critical' && s.category === 'pii.api_key')).toBe(true);
  });

  it('returns empty array when no PII present', () => {
    const d = new PiiDetector();
    expect(d.evaluate(ctx({ tool: { name: 'web_search', args: { q: 'weather today' } } }))).toEqual([]);
  });
});

describe('ClassifierDetector', () => {
  it('always emits a category signal', () => {
    const d = new ClassifierDetector();
    const signals = d.evaluate(ctx({ tool: { name: 'run_query', args: { sql: 'select 1' } } }));
    expect(signals.find(s => s.category.startsWith('classifier.'))?.category)
      .toBe('classifier.database');
  });

  it('emits a critical risk signal for SQL injection patterns', () => {
    const d = new ClassifierDetector();
    const signals = d.evaluate(ctx({
      tool: { name: 'run_query', args: { sql: "SELECT * FROM users WHERE id='1' OR '1'='1' --" } },
    }));
    expect(signals.some(s => s.category === 'risk.sql_injection' && s.severity === 'critical')).toBe(true);
  });

  it('respects user overrides', () => {
    const d = new ClassifierDetector({ my_custom_tool: 'network' });
    const signals = d.evaluate(ctx({ tool: { name: 'my_custom_tool', args: {} } }));
    expect(signals[0].category).toBe('classifier.network');
  });
});
