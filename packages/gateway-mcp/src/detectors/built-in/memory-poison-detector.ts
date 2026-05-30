/**
 * Memory-poisoning detector — flags writes to agent memory / scratchpad
 * / vector store that contain instruction-shaped or override-shaped
 * payloads.
 *
 * Coverage: AAT-T6001 (Memory Poisoning).
 *
 * Threat model: an adversary tricks the agent into persisting attacker-
 * controlled instructions into long-term storage that subsequent
 * sessions retrieve and treat as authoritative. The detector matches
 * "memory-write-like" tool calls and inspects payload content for
 * imperatives, role overrides, and known jailbreak phrasing.
 *
 * Heuristic, not perfect — a determined adversary can paraphrase. Pairs
 * with the classifier's prompt_injection signal (request-side) and the
 * lateral / cross-agent detectors (cross-session propagation) for
 * defense in depth.
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';

const NAME = 'aegis.builtin.memory-poison';
const VERSION = '1.0.0';

// Tool names that suggest a write to durable memory / vector store /
// scratchpad. Pattern-matched against the incoming tool_name.
const MEMORY_WRITE_TOOL_PATTERNS = [
  /^(write|save|store|put|append|persist|remember|memorize)_?(memory|state|context|note|fact|scratchpad)/i,
  /^(upsert|insert)_?(vector|embedding|document|memory|fact|chunk)/i,
  /^memory_(set|store|write|put|append|add)/i,
  /^cache_(set|put|store|write)/i,
  /^kb_(insert|upsert|write|add)/i,
];

// Hard override patterns — clear adversarial intent.
const OVERRIDE_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|all)\s+(?:instructions|prompts|rules)/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|prompts|rules)/i,
  /\b(?:forget|delete)\s+(?:your\s+)?(?:previous|prior)\s+(?:instructions|prompts|context)/i,
  /\byou\s+are\s+now\s+(?:a\s+)?(?:new\s+)?(?:DAN|jailbroken|unfiltered)/i,
  /\bact\s+as\s+(?:a\s+)?(?:DAN|jailbroken|developer\s+mode)/i,
  /\bsystem\s*[:>]\s*[^\s]/i,                       // "system: do X"
  /\[\s*system\s*\]/i,
  /\[\s*INST\s*\]/i,
];

// Softer imperative / instruction patterns — common in stored prompt-
// injection payloads.
const IMPERATIVE_PATTERNS = [
  /\bfrom\s+now\s+on[\s,]/i,
  /\byou\s+must\s+(?:always|never|immediately|now)/i,
  /\byou\s+are\s+required\s+to\b/i,
  /\bnew\s+(?:rule|instruction|directive)\s*[:.]/i,
  /\bimportant\s*[:.]\s*(?:when|if|whenever|always|never)/i,
  /\bnext\s+time\s+(?:you|the\s+user|the\s+agent)/i,
  /(?:^|\n|\s)>\s*(?:[A-Z][^\n]{15,})/,             // ">" quoted instruction
];

function flatStringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 256) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) flatStringValues(v, out, depth + 1);
  else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) flatStringValues(v, out, depth + 1);
  }
  return out;
}

function findFirstMatch(strs: string[], patterns: RegExp[]): { sample: string; pattern: string } | null {
  for (const s of strs) {
    for (const p of patterns) {
      const m = p.exec(s);
      if (m) return { sample: m[0].slice(0, 120), pattern: p.source };
    }
  }
  return null;
}

export class MemoryPoisonDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'content' as const;
  readonly coverage = ['AAT-T6001'] as const;

  evaluate(ctx: DetectorContext): Signal[] {
    const isMemoryWrite = MEMORY_WRITE_TOOL_PATTERNS.some(p => p.test(ctx.tool.name));
    if (!isMemoryWrite) return [];

    const strs = flatStringValues(ctx.tool.args);
    if (strs.length === 0) return [];

    const out: Signal[] = [];
    const override = findFirstMatch(strs, OVERRIDE_PATTERNS);
    if (override) {
      out.push(this.sig({
        severity: 'critical',
        category: 'persistence.memory-poison.override',
        message: `${ctx.tool.name} write contains hard override / jailbreak phrasing`,
        evidence: { tool: ctx.tool.name, match: override.sample, pattern: override.pattern },
      }));
    }

    const imperative = findFirstMatch(strs, IMPERATIVE_PATTERNS);
    if (imperative && !override) {
      out.push(this.sig({
        severity: 'warn',
        category: 'persistence.memory-poison.imperative',
        message: `${ctx.tool.name} write contains instruction-shaped content`,
        evidence: { tool: ctx.tool.name, match: imperative.sample, pattern: imperative.pattern },
      }));
    }

    return out;
  }

  private sig(opts: { severity: Severity; category: string; message: string; evidence: Record<string, unknown> }): Signal {
    return {
      detector: NAME,
      version: VERSION,
      severity: opts.severity,
      category: opts.category,
      message: opts.message,
      evidence: opts.evidence,
      ontology: ['AAT-T6001'],
    };
  }
}
