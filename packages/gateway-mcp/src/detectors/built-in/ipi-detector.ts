/**
 * Indirect Prompt Injection (IPI) detector — AAT-T1001.
 *
 * Direct prompt injection lives in the user message and is caught by the
 * classifier's prompt_injection signal. INDIRECT prompt injection hides
 * in content the agent retrieves from a TOOL — web fetches, RAG documents,
 * file reads, email bodies, calendar invites. The adversary writes
 * something the agent will retrieve, and embeds instructions inside.
 *
 * On the LLM-proxy path, the request body's `messages` array carries
 * earlier-turn tool results verbatim. The proxy adapter pulls those
 * strings out and exposes them as `ctx.conversation.toolResultContent`
 * — this detector scans them for embedded instructions and, when
 * found, raises a signal on the CURRENT call (which is operating on
 * poisoned context). Blocking that call before its tool_use executes
 * is the practical defense.
 *
 * Pattern bank overlaps MemoryPoisonDetector by design — both threats
 * share the same surface signature. The DIFFERENCE is which surface
 * carries the payload:
 *   memory-poison  →  payload heads INTO durable storage (tool args)
 *   ipi            →  payload comes OUT of tool results (conversation)
 *
 * Heuristic, not perfect. A determined adversary can paraphrase. Pair
 * with output validation, retrieval-source pinning, and trust-domain
 * separation on the customer's side.
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';

const NAME = 'aegis.builtin.ipi';
const VERSION = '1.0.0';

// Hard-override / explicit jailbreak phrasing — clear adversarial intent
// when found in retrieved content (not in the user's own prompt).
const OVERRIDE_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|all)\s+(?:instructions|prompts|rules|system\s+message)/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|prompts|rules)/i,
  /\b(?:forget|delete)\s+(?:your\s+)?(?:previous|prior)\s+(?:instructions|prompts|context)/i,
  /\byou\s+are\s+now\s+(?:a\s+)?(?:new\s+|jailbroken\s+|unfiltered\s+)?(?:DAN|developer\s+mode)/i,
  /\bact\s+as\s+(?:a\s+)?(?:DAN|jailbroken|developer\s+mode)/i,
  /\bsystem\s*[:>]\s*\S/i,                          // "system: do X"
  /\[\s*(?:system|inst|sys)\s*\]/i,
  /<\|im_start\|>\s*system/i,                       // ChatML-style smuggle
  /<\|system\|>/i,
];

// Imperative phrasing common in IPI payloads. Lower severity — these
// also appear in legit retrieved content (technical docs, FAQs).
const IMPERATIVE_PATTERNS = [
  /\bimportant\s*[:.]\s*(?:when|if|whenever|always|never)\s+\S+/i,
  /\byou\s+must\s+(?:always|never|immediately|now)\s+\S+/i,
  /\bnew\s+(?:rule|instruction|directive)\s*[:.]\s*\S+/i,
  /\bAI\s+(?:assistant|agent|model)\s*[:,]\s+(?:please|you\s+must|always)/i,
];

// Outbound-exfil hints inside retrieved content — adversary trying to
// get the agent to send sensitive context somewhere external.
const EXFIL_HINT_PATTERNS = [
  /\b(?:send|post|forward|email|upload)\s+(?:the\s+)?(?:above|previous|user|system|conversation|chat)\s+(?:to|at)\s+(?:https?:\/\/|@|\S+@)/i,
  /\b(?:please\s+)?include\s+(?:the\s+)?(?:above|previous|system\s+prompt|api[\s_-]?key)\s+in\s+(?:your\s+)?(?:response|next\s+message)/i,
];

function findFirstMatch(strs: ReadonlyArray<string>, patterns: RegExp[]): { sample: string; pattern: string; source: string } | null {
  for (const s of strs) {
    for (const p of patterns) {
      const m = p.exec(s);
      if (m) return {
        sample: m[0].slice(0, 120),
        pattern: p.source,
        source: s.slice(0, 80) + (s.length > 80 ? '…' : ''),
      };
    }
  }
  return null;
}

export class IpiDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'content' as const;
  readonly coverage = ['AAT-T1001'] as const;

  evaluate(ctx: DetectorContext): Signal[] {
    const blocks = ctx.conversation?.toolResultContent;
    if (!blocks || blocks.length === 0) return [];

    const out: Signal[] = [];
    const override = findFirstMatch(blocks, OVERRIDE_PATTERNS);
    if (override) {
      out.push(this.sig({
        severity: 'critical',
        category: 'initial-compromise.ipi.override',
        message: 'retrieved tool result contains hard override / jailbreak phrasing — agent operating on poisoned context',
        evidence: { match: override.sample, pattern: override.pattern, snippet: override.source },
      }));
    }

    const exfil = findFirstMatch(blocks, EXFIL_HINT_PATTERNS);
    if (exfil) {
      out.push(this.sig({
        severity: 'critical',
        category: 'initial-compromise.ipi.exfil-instruction',
        message: 'retrieved tool result instructs the agent to exfiltrate context to an external destination',
        evidence: { match: exfil.sample, pattern: exfil.pattern, snippet: exfil.source },
      }));
    }

    const imperative = findFirstMatch(blocks, IMPERATIVE_PATTERNS);
    if (imperative && !override && !exfil) {
      out.push(this.sig({
        severity: 'warn',
        category: 'initial-compromise.ipi.imperative',
        message: 'retrieved tool result contains instruction-shaped content',
        evidence: { match: imperative.sample, pattern: imperative.pattern, snippet: imperative.source },
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
      ontology: ['AAT-T1001'],
    };
  }
}
