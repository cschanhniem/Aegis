/**
 * TaintTrackerService — per-session window of "the agent has touched
 * sensitive content recently".
 *
 * Combined with the SensitiveExfilDetector, this is how AEGIS sees the
 * temporal connection between "agent read a secret" and "agent makes an
 * outbound network call". One half tracks; the other half catches.
 *
 * Storage model — in-memory, per-process. Bounded by maxSessions; same
 * shape and trade-offs as CrossAgentCorrelatorService. Swap for Redis in
 * multi-instance deployments.
 *
 * Taint markers are detector category strings — we don't try to capture
 * the actual sensitive value (that would defeat the audit-log redaction
 * we already do). We just remember "category X tripped at time T".
 */

import { Signal } from '@agentguard/core-schema';
import { Logger } from 'pino';

interface SessionTaint {
  /** Last-seen timestamp per category. */
  categories: Map<string, number>;
  lastActivity: number;
}

export interface TaintMatch {
  /** Categories that lit up within the window. */
  readonly categories: ReadonlyArray<string>;
  /** Milliseconds since the most recent taint event in this window. */
  readonly recentMs: number;
}

export interface TaintTrackerOptions {
  /** Max live sessions; oldest evicted on overflow. Default 4096. */
  maxSessions?: number;
  /** Inactivity TTL (ms) before a session is forgotten. Default 1h. */
  sessionTtlMs?: number;
  /** Detector categories that count as "taint". Default covers PII,
   *  credential-access, and secret-in-args. Customers can extend per
   *  tenant in a future config-driven version. */
  taintCategories?: ReadonlyArray<RegExp>;
  logger?: Logger;
}

const DEFAULT_TAINT_CATEGORIES: RegExp[] = [
  /^pii\./i,
  /^risk\.pii_in_args$/i,
  /^discovery\.credential-discovery$/i,
  /^lateral\.token-replay$/i,
];

export class TaintTrackerService {
  private sessions = new Map<string, SessionTaint>();
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;
  private readonly taintCategories: ReadonlyArray<RegExp>;
  private readonly logger?: Logger;

  constructor(opts: TaintTrackerOptions = {}) {
    this.maxSessions    = opts.maxSessions ?? 4096;
    this.sessionTtlMs   = opts.sessionTtlMs ?? 60 * 60 * 1000;
    this.taintCategories = opts.taintCategories ?? DEFAULT_TAINT_CATEGORIES;
    this.logger         = opts.logger;
  }

  /** Record taint markers from a freshly-evaluated detector chain. Called
   *  once per request, after detectors run. */
  observe(opts: {
    orgId: string;
    sessionId?: string;
    signals: ReadonlyArray<Signal>;
  }): void {
    if (!opts.sessionId) return;
    const tainted = opts.signals
      .filter(s => this.taintCategories.some(rx => rx.test(s.category)))
      .map(s => s.category);
    if (tainted.length === 0) return;

    this.pruneExpired();
    const key = sessionKey(opts.orgId, opts.sessionId);
    const state = this.sessions.get(key) ?? { categories: new Map(), lastActivity: 0 };
    const now = Date.now();
    for (const c of tainted) state.categories.set(c, now);
    state.lastActivity = now;
    this.sessions.set(key, state);
    if (this.sessions.size > this.maxSessions) this.evictOldest();
  }

  /** Check if the session has any active taint within the given window
   *  (default 5 minutes). */
  check(opts: { orgId: string; sessionId?: string; windowMs?: number }): TaintMatch | null {
    if (!opts.sessionId) return null;
    const state = this.sessions.get(sessionKey(opts.orgId, opts.sessionId));
    if (!state) return null;
    const window = opts.windowMs ?? 5 * 60 * 1000;
    const cutoff = Date.now() - window;
    const live: string[] = [];
    let mostRecent = 0;
    for (const [cat, ts] of state.categories) {
      if (ts >= cutoff) {
        live.push(cat);
        if (ts > mostRecent) mostRecent = ts;
      }
    }
    if (live.length === 0) return null;
    return { categories: live, recentMs: Date.now() - mostRecent };
  }

  size(): number { return this.sessions.size; }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [k, v] of this.sessions) {
      if (v.lastActivity < cutoff) this.sessions.delete(k);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestT = Number.MAX_SAFE_INTEGER;
    for (const [k, v] of this.sessions) {
      if (v.lastActivity < oldestT) { oldestT = v.lastActivity; oldestKey = k; }
    }
    if (oldestKey) this.sessions.delete(oldestKey);
  }
}

function sessionKey(orgId: string, sessionId: string): string {
  return `${orgId}|${sessionId}`;
}
