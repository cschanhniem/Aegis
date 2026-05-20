/**
 * Single-process buffer for the latest alignment verdict per
 * agent_id. Mirrors the Python `_alignment_state` module.
 *
 * The alignment helper records into this buffer; the auto-
 * instrumentation interceptor consumes it (single-use, TTL) when
 * building the next /check payload for that agent. DSL rules like
 * `{ alignment.drifted: true }` then fire on the same hop.
 */

export const TTL_MS = 30_000;

interface Entry {
  ts: number;
  verdict: Record<string, unknown>;
}

const state = new Map<string, Entry>();

export function record(agentId: string, verdict: Record<string, unknown>): void {
  if (!agentId || typeof verdict !== 'object' || verdict === null) return;
  state.set(agentId, { ts: Date.now(), verdict });
}

export function consume(agentId: string): Record<string, unknown> | null {
  const entry = state.get(agentId);
  if (!entry) return null;
  state.delete(agentId);
  if (Date.now() - entry.ts > TTL_MS) return null;
  return entry.verdict;
}

export function reset(): void {
  state.clear();
}

/**
 * Project a /alignment/check response down to the shape /check
 * accepts under the `alignment` field. The gateway zod schema
 * requires a numeric `score` (clamped to [0,1]); everything else
 * is optional. Unknown fields are dropped, signals are capped at
 * 5 entries × 40 chars to match the gateway bound.
 */
export function toCheckPayload(
  verdict: Record<string, unknown>,
): {
  score: number;
  drifted?: boolean;
  signals?: string[];
  reason?: string;
} | null {
  const scoreRaw = verdict.score;
  if (typeof scoreRaw !== 'number' || Number.isNaN(scoreRaw)) return null;
  const out: ReturnType<typeof toCheckPayload> = {
    score: Math.max(0, Math.min(1, scoreRaw)),
  };
  if (typeof verdict.drifted === 'boolean') out!.drifted = verdict.drifted;
  if (Array.isArray(verdict.signals)) {
    const signals = (verdict.signals as unknown[])
      .filter((s): s is string | number => typeof s === 'string' || typeof s === 'number')
      .map((s) => String(s).slice(0, 40))
      .slice(0, 5);
    if (signals.length) out!.signals = signals;
  }
  if (typeof verdict.reason === 'string') {
    out!.reason = verdict.reason.slice(0, 500);
  }
  return out;
}
