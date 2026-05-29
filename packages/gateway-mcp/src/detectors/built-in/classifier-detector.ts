/**
 * Tool classifier detector — wraps `classifyToolCall` so its category and
 * per-arg risk findings flow into the unified Signal[] stream.
 *
 * Emits:
 *   1. One `classify` signal for the inferred tool category (kind=classify
 *      runs first so other detectors can read `ctx.upstream` if needed).
 *   2. One `content` risk signal per RiskSignal returned (sql_injection,
 *      shell_injection, prompt_injection, etc).
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';
import { classifyToolCall, ToolCategory } from '../../services/classifier';

const NAME = 'aegis.builtin.classifier';
const VERSION = '1.0.0';

export class ClassifierDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'classify' as const;
  // Coverage spans execution-tactic technique IDs the existing risk
  // signal set already identifies (sql/shell/path/prompt-injection/etc),
  // plus jailbreak detection and classifier-misdirection signals.
  readonly coverage = [
    'AAT-T1004',  // Jailbreak / Policy Bypass (prompt-injection risk signal)
    'AAT-T2003',  // Unintended Code Execution (shell_injection signal)
    'AAT-T2004',  // SQL Injection via Tool
    'AAT-T2005',  // SSRF via Network Tool (network category + plaintext_url)
    'AAT-T9002',  // Classifier Misdirection (we detect, we don't yet evade-protect)
    'AAT-T1003',  // Tool Supply-Chain Compromise (unsafe_publish / secret_in_build)
  ] as const;

  constructor(private overrides: Record<string, ToolCategory> = {}) {}

  evaluate(ctx: DetectorContext): Signal[] {
    const result = classifyToolCall(ctx.tool.name, ctx.tool.args, this.overrides);
    const signals: Signal[] = [];

    signals.push({
      detector: NAME,
      version: VERSION,
      severity: 'info',
      category: `classifier.${result.category}`,
      message: `tool classified as ${result.category} (via ${result.source})`,
      evidence: {
        category: result.category,
        source: result.source,
        signals: result.signals,
      },
    });

    for (const risk of result.risks) {
      signals.push({
        detector: NAME,
        version: VERSION,
        severity: mapSeverity(risk.severity),
        category: `risk.${risk.type}`,
        message: risk.detail,
        evidence: { type: risk.type, severity: risk.severity },
      });
    }

    return signals;
  }
}

function mapSeverity(level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): Severity {
  switch (level) {
    case 'LOW': return 'info';
    case 'MEDIUM': return 'warn';
    case 'HIGH':
    case 'CRITICAL':
      return 'critical';
  }
}
