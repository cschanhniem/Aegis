/**
 * Sensitive-context exfiltration detector — AAT-T5001.
 *
 * Connects "the agent read a secret recently" to "the agent is now making
 * an outbound network call". Either signal on its own is ambiguous; the
 * temporal connection is the threat.
 *
 * Decision:
 *   critical  current tool is outbound AND session has live taint in the
 *             configured window (default 5 minutes)
 *   quiet     otherwise — the PII detector and the existing exfil
 *             detector each fire their own non-temporal signals
 *
 * Coverage: AAT-T5001 (Outbound Network with Sensitive Context). This
 * is the previously-uncovered red node in data-exfiltration.
 */

import { Detector, DetectorContext, Signal } from '@agentguard/core-schema';
import { TaintTrackerService } from '../../services/taint-tracker';

const NAME = 'aegis.builtin.sensitive-exfil';
const VERSION = '1.0.0';

// Outbound-shaped tool names. Same bank as ExfilDetector intentionally —
// they should agree on what "outbound" means.
const OUTBOUND_TOOL_PATTERNS = [
  /^(http|fetch|request|get|post|put|curl|wget)/i,
  /^(send|post|push|upload|publish|notify)/i,
  /^webhook/i,
  /^email/i,
  /^slack/i,
  /^s3_?(put|upload)/i,
  /^gcs_?(put|upload)/i,
  /^azure_?(blob|upload)/i,
];

export class SensitiveExfilDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'meta' as const;
  readonly coverage = ['AAT-T5001'] as const;

  constructor(private taint: TaintTrackerService) {}

  evaluate(ctx: DetectorContext): Signal[] {
    if (!OUTBOUND_TOOL_PATTERNS.some(p => p.test(ctx.tool.name))) return [];

    const match = this.taint.check({
      orgId: ctx.tenant.id,
      sessionId: ctx.session?.id,
    });
    if (!match) return [];

    return [{
      detector: NAME,
      version: VERSION,
      severity: 'critical',
      category: 'data-exfiltration.sensitive-context',
      message: `outbound tool '${ctx.tool.name}' invoked within ${Math.round(match.recentMs / 1000)}s of touching sensitive content (${match.categories.length} taint marker(s))`,
      evidence: {
        tool: ctx.tool.name,
        taint_categories: [...match.categories],
        ms_since_taint: match.recentMs,
      },
      ontology: ['AAT-T5001'],
    }];
  }
}
