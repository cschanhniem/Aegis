/**
 * Lateral-movement detector — surfaces signs of cross-agent / cross-
 * session compromise propagation.
 *
 * Coverage (partial — full multi-agent correlator is v1.1):
 *   AAT-T10002  Session / Token Replay Across Agents — session tokens,
 *               bearer auth headers, or JWTs appearing in tool args.
 *
 * Why this overlaps the PII detector but isn't the same: PII flags any
 * secret-shaped string for redaction. This detector specifically watches
 * for the case where a tool call carries a token in a SHAPE that suggests
 * the agent is passing its own (or another agent's) auth onward — the
 * threat model is replay, not leakage.
 *
 * AAT-T10001 (Cross-Agent Trust Abuse) requires a cross-agent state
 * machine that observes whose outputs feed into whose inputs; that
 * lives in a future MultiAgentCorrelator service (v1.1).
 */

import { Detector, DetectorContext, Signal } from '@agentguard/core-schema';

const NAME = 'aegis.builtin.lateral';
const VERSION = '1.0.0';

// Tool ARG keys whose names suggest the value SHOULD be a token. When
// these appear in an outbound tool call we treat them as token-replay
// candidates rather than ambient PII leakage.
const TOKEN_KEYS = [
  'authorization',
  'auth',
  'bearer',
  'token',
  'access_token',
  'session_token',
  'session_id',
  'sid',
  'jwt',
  'x-api-key',
  'cookie',
  'set-cookie',
];

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/;

function walk(node: unknown, found: { key: string; value: string }[], path: string[] = [], depth = 0): void {
  if (depth > 8 || found.length > 16) return;
  if (typeof node === 'string') {
    const key = path[path.length - 1] ?? '';
    found.push({ key, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, found, [...path, String(i)], depth + 1));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, found, [...path, k], depth + 1);
  }
}

export class LateralMovementDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'content' as const;
  readonly coverage = ['AAT-T10002'] as const;

  evaluate(ctx: DetectorContext): Signal[] {
    const found: { key: string; value: string }[] = [];
    walk(ctx.tool.args, found);
    if (found.length === 0) return [];

    const out: Signal[] = [];
    const seen = new Set<string>();
    for (const { key, value } of found) {
      const lkey = key.toLowerCase();
      const keySaysToken = TOKEN_KEYS.includes(lkey);
      const jwt = JWT_RE.test(value);
      const bearer = BEARER_RE.test(value);
      if (!keySaysToken && !jwt && !bearer) continue;

      const dedupKey = `${lkey}|${jwt ? 'jwt' : bearer ? 'bearer' : 'key'}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      out.push({
        detector: NAME,
        version: VERSION,
        severity: 'critical',
        category: 'lateral.token-replay',
        message: `auth token appears in tool args under '${key || '<top-level>'}' — possible replay`,
        evidence: {
          tool: ctx.tool.name,
          arg_key: key,
          token_shape: jwt ? 'jwt' : bearer ? 'bearer' : 'token-shaped',
        },
        ontology: ['AAT-T10002'],
      });
    }
    return out;
  }
}
