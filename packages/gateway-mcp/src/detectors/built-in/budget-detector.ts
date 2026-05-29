/**
 * Budget detector — wraps BudgetGuardService into the unified Detector
 * contract so cost-burn signals flow through the same decision merger,
 * audit log, sink fan-out, and transparency log as security signals.
 *
 * Decision semantics:
 *   action='log'    every threshold crossing → info signal
 *   action='warn'   crossing warnAt → warn signal; over-limit → warn (NOT block)
 *   action='block'  crossing warnAt → warn; over-limit → critical (blocks)
 *
 * Why kind='meta': budget is tenant-ambient, not tied to one tool-call's
 * content. Runs after content/behavior/classify detectors so it observes
 * the same context but contributes its own ambient signal.
 *
 * Maps to AAT-T8002 (Budget / Cost Burndown) — moves that node from
 * "anomaly partially detects spike" to "actively enforced with declared
 * limits".
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';
import { BudgetGuardService, BudgetStatusEntry } from '../../services/budget-guard';

const NAME = 'aegis.builtin.budget';
const VERSION = '1.0.0';

export class BudgetDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'meta' as const;
  readonly coverage = ['AAT-T8002'] as const;

  constructor(private guard: BudgetGuardService) {}

  evaluate(ctx: DetectorContext): Signal[] {
    const decision = this.guard.evaluate({
      orgId: ctx.tenant.id,
      agentId: ctx.agent.id,
      sessionId: ctx.session?.id,
    });
    if (!decision) return [];

    const interesting = decision.entries.filter(e => e.severity !== 'ok');
    if (interesting.length === 0) return [];

    return interesting.map(e => ({
      detector: NAME,
      version: VERSION,
      severity: mapSeverity(e.severity as 'warn' | 'critical', decision.action),
      category: `budget.${e.scope}`,
      message: messageFor(e),
      evidence: {
        scope: e.scope,
        limit_usd: e.limitUsd,
        spent_usd: e.spentUsd,
        fraction: e.fraction,
        window_start: e.windowStart,
        action: decision.action,
      },
      ontology: ['AAT-T8002'],
    }));
  }
}

function mapSeverity(s: 'warn' | 'critical', action: 'log' | 'warn' | 'block'): Severity {
  if (action === 'log') return 'info';
  if (action === 'warn') return 'warn';
  // action = 'block': over-limit becomes critical; warn stays warn.
  return s === 'critical' ? 'critical' : 'warn';
}

function messageFor(e: BudgetStatusEntry): string {
  const pct = (e.fraction * 100).toFixed(1);
  const verb = e.severity === 'critical' ? 'EXCEEDED' : 'approaching';
  return `${e.scope} budget ${verb}: $${e.spentUsd.toFixed(4)} of $${e.limitUsd.toFixed(2)} (${pct}%)`;
}
