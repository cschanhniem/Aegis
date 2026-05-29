/**
 * PII content detector — wraps the existing `redactPii` pattern matcher
 * so it participates in the DetectorRegistry chain. The wrapper itself
 * does NOT mutate args (redaction stays where it was — in the trace
 * persistence path). It only emits Signal records for each PII type the
 * scanner finds, which downstream policy/sink layers can act on.
 */

import { Detector, DetectorContext, Signal } from '@agentguard/core-schema';
import { redactPii } from '../../services/pii';

const NAME = 'aegis.builtin.pii';
const VERSION = '1.0.0';

function flatStringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 256) return out;
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) flatStringValues(v, out, depth + 1);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) flatStringValues(v, out, depth + 1);
  }
  return out;
}

export class PiiDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'content' as const;

  evaluate(ctx: DetectorContext): Signal[] {
    const strings = flatStringValues(ctx.tool.args);
    if (strings.length === 0) return [];

    const seen = new Map<string, number>();
    for (const s of strings) {
      const r = redactPii(s);
      for (const t of r.types) seen.set(t, (seen.get(t) ?? 0) + 1);
    }
    if (seen.size === 0) return [];

    const signals: Signal[] = [];
    for (const [type, count] of seen) {
      signals.push({
        detector: NAME,
        version: VERSION,
        severity: severityFor(type),
        category: `pii.${type.toLowerCase()}`,
        message: `${type} detected in tool arguments (${count} match${count === 1 ? '' : 'es'})`,
        evidence: { type, occurrences: count },
      });
    }
    return signals;
  }
}

function severityFor(piiType: string): 'info' | 'warn' | 'critical' {
  switch (piiType) {
    case 'PRIVATE_KEY':
    case 'API_KEY':
    case 'JWT':
    case 'DB_CONNECTION':
    case 'AWS_ARN':
      return 'critical';
    case 'SSN':
    case 'CREDIT_CARD':
      return 'critical';
    case 'EMAIL':
    case 'PHONE':
    case 'IP_ADDRESS':
      return 'warn';
    default:
      return 'info';
  }
}
