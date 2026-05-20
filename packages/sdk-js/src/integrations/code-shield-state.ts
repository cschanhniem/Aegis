/**
 * Thread-safe (single-process) buffer for the latest CodeShield scan
 * result per agent_id. Mirrors the Python SDK module of the same name.
 *
 * The `code_shield.scan(...)` helper records into this buffer; the
 * auto-instrumentation interceptor consumes it (once, within TTL_MS)
 * the next time it builds a /check payload for that agent. DSL rules
 * like `{ code_shield.worst: CRITICAL }` then fire on the same hop.
 *
 * Node is single-threaded JS, but multiple concurrent agents living
 * in the same process can share this buffer — we key by agent_id so
 * verdicts don't bleed across tenants.
 */

export const TTL_MS = 30_000;

interface Entry {
  ts: number;
  result: Record<string, unknown>;
}

const state = new Map<string, Entry>();

export function record(agentId: string, result: Record<string, unknown>): void {
  if (!agentId || typeof result !== 'object' || result === null) return;
  state.set(agentId, { ts: Date.now(), result });
}

export function consume(agentId: string): Record<string, unknown> | null {
  const entry = state.get(agentId);
  if (!entry) return null;
  state.delete(agentId);
  if (Date.now() - entry.ts > TTL_MS) return null;
  return entry.result;
}

export function reset(): void {
  state.clear();
}

/**
 * Project a /code-shield/scan response down to the shape /check accepts
 * under the `code_shield` field. Drops unknown fields, dedupes rule ids,
 * caps the list at 64 to match the gateway's zod bound.
 */
export function toCheckPayload(
  result: Record<string, unknown>,
): {
  worst: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  findings_count: number;
  rules?: string[];
} {
  const worstRaw = result.worst;
  const worst =
    worstRaw === 'LOW' || worstRaw === 'MEDIUM' || worstRaw === 'HIGH' || worstRaw === 'CRITICAL'
      ? worstRaw
      : null;

  let count =
    typeof result.unique_findings === 'number' && result.unique_findings >= 0
      ? Math.floor(result.unique_findings)
      : Array.isArray(result.findings)
        ? result.findings.length
        : 0;

  const findings = Array.isArray(result.findings) ? result.findings : [];
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const rule = (f as Record<string, unknown>).rule;
    if (typeof rule === 'string' && rule.length <= 80 && !seen.has(rule)) {
      seen.add(rule);
      rules.push(rule);
      if (rules.length >= 64) break;
    }
  }

  return {
    worst,
    findings_count: count,
    ...(rules.length ? { rules } : {}),
  };
}
