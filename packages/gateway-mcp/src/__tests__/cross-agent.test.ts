import { DetectorContext, Signal } from '@agentguard/core-schema';
import { CrossAgentCorrelatorService } from '../services/cross-agent-correlator';
import { CrossAgentDetector } from '../detectors/built-in/cross-agent-detector';

const ctx = (agentId: string, sessionId?: string): DetectorContext => ({
  tool: { name: 'web_search', args: {} },
  agent: { id: agentId },
  tenant: { id: 'default' },
  session: sessionId ? { id: sessionId } : undefined,
});

function critical(category = 'risk.shell_injection'): Signal {
  return {
    detector: 't', version: '1', severity: 'critical', category,
    message: 'x',
  };
}

describe('CrossAgentCorrelatorService', () => {
  it('returns empty inspection on unknown session', () => {
    const svc = new CrossAgentCorrelatorService();
    const r = svc.inspect({ orgId: 'o', sessionId: 's-1', currentAgentId: 'a' });
    expect(r.otherAgents).toEqual([]);
  });

  it('observe is a no-op when sessionId is missing', () => {
    const svc = new CrossAgentCorrelatorService();
    svc.observe({ orgId: 'o', agentId: 'a', signals: [] });
    expect(svc.size()).toBe(0);
  });

  it('records other agents in the same session', () => {
    const svc = new CrossAgentCorrelatorService();
    svc.observe({ orgId: 'o', sessionId: 's-1', agentId: 'a', signals: [] });
    svc.observe({ orgId: 'o', sessionId: 's-1', agentId: 'b', signals: [] });
    const r = svc.inspect({ orgId: 'o', sessionId: 's-1', currentAgentId: 'b' });
    expect(r.otherAgents).toEqual(['a']);
    expect(r.otherAgentsWithCritical).toEqual([]);
  });

  it('flags critical signals on prior agents', () => {
    const svc = new CrossAgentCorrelatorService();
    svc.observe({ orgId: 'o', sessionId: 's-1', agentId: 'a', signals: [critical('risk.foo')] });
    svc.observe({ orgId: 'o', sessionId: 's-1', agentId: 'b', signals: [] });
    const r = svc.inspect({ orgId: 'o', sessionId: 's-1', currentAgentId: 'b' });
    expect(r.otherAgentsWithCritical).toHaveLength(1);
    expect(r.otherAgentsWithCritical[0].agentId).toBe('a');
    expect(r.otherAgentsWithCritical[0].criticalCategories).toContain('risk.foo');
  });

  it('isolates sessions across tenants', () => {
    const svc = new CrossAgentCorrelatorService();
    svc.observe({ orgId: 'o-1', sessionId: 's-1', agentId: 'a', signals: [critical()] });
    svc.observe({ orgId: 'o-2', sessionId: 's-1', agentId: 'b', signals: [] });
    const r = svc.inspect({ orgId: 'o-2', sessionId: 's-1', currentAgentId: 'b' });
    expect(r.otherAgents).toEqual([]);   // o-1 record doesn't leak
  });

  it('evicts oldest when over capacity', () => {
    const svc = new CrossAgentCorrelatorService({ maxSessions: 2 });
    svc.observe({ orgId: 'o', sessionId: 's-1', agentId: 'a', signals: [] });
    // Force later lastActivity for s-2 and s-3.
    setTimeout(() => svc.observe({ orgId: 'o', sessionId: 's-2', agentId: 'a', signals: [] }), 1);
    setTimeout(() => svc.observe({ orgId: 'o', sessionId: 's-3', agentId: 'a', signals: [] }), 2);
    // Synchronously seed s-2/s-3 since setTimeout is async; do it directly.
    svc.observe({ orgId: 'o', sessionId: 's-2', agentId: 'a', signals: [] });
    svc.observe({ orgId: 'o', sessionId: 's-3', agentId: 'a', signals: [] });
    expect(svc.size()).toBeLessThanOrEqual(2);
  });
});

describe('CrossAgentDetector', () => {
  it('quiet when no session_id', () => {
    const svc = new CrossAgentCorrelatorService();
    const d = new CrossAgentDetector(svc);
    expect(d.evaluate(ctx('a'))).toEqual([]);
  });

  it('quiet when only one agent in this session', () => {
    const svc = new CrossAgentCorrelatorService();
    const d = new CrossAgentDetector(svc);
    svc.observe({ orgId: 'default', sessionId: 's-1', agentId: 'a', signals: [] });
    expect(d.evaluate(ctx('a', 's-1'))).toEqual([]);
  });

  it('emits info when 2+ agents share a session (no critical yet)', () => {
    const svc = new CrossAgentCorrelatorService();
    const d = new CrossAgentDetector(svc);
    svc.observe({ orgId: 'default', sessionId: 's-1', agentId: 'a', signals: [] });
    const s = d.evaluate(ctx('b', 's-1'));
    expect(s[0]?.severity).toBe('info');
    expect(s[0]?.category).toBe('lateral.shared-session');
    expect(s[0]?.ontology).toContain('AAT-T10001');
  });

  it('emits critical when a session peer was previously flagged', () => {
    const svc = new CrossAgentCorrelatorService();
    const d = new CrossAgentDetector(svc);
    svc.observe({
      orgId: 'default', sessionId: 's-1', agentId: 'compromised',
      signals: [critical('risk.shell_injection')],
    });
    const s = d.evaluate(ctx('victim', 's-1'));
    expect(s[0]?.severity).toBe('critical');
    expect(s[0]?.category).toBe('lateral.cross-agent-trust-abuse');
    expect(s[0]?.ontology).toContain('AAT-T10001');
    expect((s[0]?.evidence as any).flagged_agents).toContain('compromised');
    expect((s[0]?.evidence as any).inherited_critical_categories).toContain('risk.shell_injection');
  });

  it('coverage declares AAT-T10001', () => {
    const svc = new CrossAgentCorrelatorService();
    const d = new CrossAgentDetector(svc);
    expect([...d.coverage]).toEqual(['AAT-T10001']);
  });
});
