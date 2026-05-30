/**
 * Cross-agent detector — surfaces multi-agent compromise inheritance.
 *
 * When agent B operates inside a session where agent A was already flagged
 * critical, B is operating on possibly-poisoned context (A's tool outputs
 * fed B's prompts). The detector queries the CrossAgentCorrelatorService
 * for prior-call state in the same session and emits:
 *
 *   critical  ⇽ ≥1 other agent in this session produced critical signals
 *   info      ⇽ ≥1 other agent shares this session (no critical yet — just
 *                surfaces the multi-agent topology for compliance)
 *
 * Coverage: AAT-T10001 (Cross-Agent Trust Abuse). The remaining red node
 * in the lateral-movement tactic now has a primary detector.
 */

import { Detector, DetectorContext, Signal } from '@agentguard/core-schema';
import { CrossAgentCorrelatorService } from '../../services/cross-agent-correlator';

const NAME = 'aegis.builtin.cross-agent';
const VERSION = '1.0.0';

export class CrossAgentDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'meta' as const;
  readonly coverage = ['AAT-T10001'] as const;

  constructor(private correlator: CrossAgentCorrelatorService) {}

  evaluate(ctx: DetectorContext): Signal[] {
    if (!ctx.session?.id) return [];
    const r = this.correlator.inspect({
      orgId: ctx.tenant.id,
      sessionId: ctx.session.id,
      currentAgentId: ctx.agent.id,
    });
    if (r.otherAgents.length === 0) return [];

    if (r.otherAgentsWithCritical.length > 0) {
      const cats = new Set<string>();
      for (const f of r.otherAgentsWithCritical) for (const c of f.criticalCategories) cats.add(c);
      return [{
        detector: NAME,
        version: VERSION,
        severity: 'critical',
        category: 'lateral.cross-agent-trust-abuse',
        message: `agent operates in session shared with ${r.otherAgentsWithCritical.length} previously-flagged agent(s)`,
        evidence: {
          session_agent_count: r.sessionAgentCount,
          flagged_agents: r.otherAgentsWithCritical.map(a => a.agentId),
          inherited_critical_categories: [...cats],
        },
        ontology: ['AAT-T10001'],
      }];
    }
    return [{
      detector: NAME,
      version: VERSION,
      severity: 'info',
      category: 'lateral.shared-session',
      message: `agent shares session with ${r.otherAgents.length} other agent(s)`,
      evidence: { session_agent_count: r.sessionAgentCount, other_agents: r.otherAgents },
      ontology: ['AAT-T10001'],
    }];
  }
}
