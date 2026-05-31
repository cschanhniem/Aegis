import { DetectorContext, Signal } from '@agentguard/core-schema';
import { TaintTrackerService } from '../services/taint-tracker';
import { SensitiveExfilDetector } from '../detectors/built-in/sensitive-exfil-detector';

function piiSignal(category = 'pii.email'): Signal {
  return { detector: 'test', version: '1', severity: 'warn', category, message: 'm' };
}
function credSignal(): Signal {
  return { detector: 'test', version: '1', severity: 'critical', category: 'discovery.credential-discovery', message: 'm' };
}
function neutralSignal(): Signal {
  return { detector: 'test', version: '1', severity: 'info', category: 'classifier.web_search', message: 'm' };
}

const ctx = (tool: string, sessionId = 's-1'): DetectorContext => ({
  tool: { name: tool, args: {} },
  agent: { id: 'a-1' },
  tenant: { id: 'default' },
  session: { id: sessionId },
});

describe('TaintTrackerService', () => {
  it('records taint markers from PII signals', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', sessionId: 's-1', signals: [piiSignal('pii.email'), piiSignal('pii.ssn')] });
    const m = t.check({ orgId: 'default', sessionId: 's-1' });
    expect(m).not.toBeNull();
    expect([...m!.categories].sort()).toEqual(['pii.email', 'pii.ssn']);
  });

  it('records credential-discovery as taint', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', sessionId: 's-1', signals: [credSignal()] });
    const m = t.check({ orgId: 'default', sessionId: 's-1' });
    expect(m?.categories).toContain('discovery.credential-discovery');
  });

  it('ignores non-taint signals', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', sessionId: 's-1', signals: [neutralSignal()] });
    expect(t.check({ orgId: 'default', sessionId: 's-1' })).toBeNull();
  });

  it('isolates sessions across tenants', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'o-1', sessionId: 's-1', signals: [piiSignal()] });
    expect(t.check({ orgId: 'o-2', sessionId: 's-1' })).toBeNull();
  });

  it('drops markers older than the requested window', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', sessionId: 's-1', signals: [piiSignal()] });
    // Negative window — every marker falls outside (cutoff is in the
    // future). Equivalent to "show me taint from after now".
    expect(t.check({ orgId: 'default', sessionId: 's-1', windowMs: -1 })).toBeNull();
  });

  it('no-op when sessionId is missing', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', signals: [piiSignal()] });
    expect(t.size()).toBe(0);
  });
});

describe('SensitiveExfilDetector', () => {
  it('quiet when current tool is not outbound', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', sessionId: 's-1', signals: [piiSignal()] });
    const d = new SensitiveExfilDetector(t);
    expect(d.evaluate(ctx('read_file'))).toEqual([]);
  });

  it('quiet when outbound but no recent taint', () => {
    const t = new TaintTrackerService();
    const d = new SensitiveExfilDetector(t);
    expect(d.evaluate(ctx('http_post'))).toEqual([]);
  });

  it('critical when outbound AND recent taint in same session', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', sessionId: 's-1', signals: [piiSignal('pii.email')] });
    const d = new SensitiveExfilDetector(t);
    const s = d.evaluate(ctx('http_post'));
    expect(s[0]?.severity).toBe('critical');
    expect(s[0]?.category).toBe('data-exfiltration.sensitive-context');
    expect(s[0]?.ontology).toContain('AAT-T5001');
    expect((s[0]?.evidence as any).taint_categories).toContain('pii.email');
  });

  it('quiet when outbound but taint was in a different session', () => {
    const t = new TaintTrackerService();
    t.observe({ orgId: 'default', sessionId: 's-other', signals: [piiSignal()] });
    const d = new SensitiveExfilDetector(t);
    expect(d.evaluate(ctx('webhook', 's-1'))).toEqual([]);
  });

  it('declares coverage for AAT-T5001', () => {
    const t = new TaintTrackerService();
    const d = new SensitiveExfilDetector(t);
    expect([...d.coverage]).toEqual(['AAT-T5001']);
  });
});
