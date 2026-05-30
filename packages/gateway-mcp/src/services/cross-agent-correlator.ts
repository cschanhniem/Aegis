/**
 * CrossAgentCorrelatorService — keeps a per-session view of who's been
 * calling AEGIS in the same session and whether anyone tripped a critical
 * signal yet. CrossAgentDetector reads this state to emit T10001
 * (Cross-Agent Trust Abuse) signals when a new agent operates inside a
 * session where another agent was already flagged.
 *
 * Storage model — in-memory, per-process. Bounded by maxSessions; oldest
 * inactive session evicted first. The signal this surfaces is most useful
 * at the timescale of a single conversation / agent loop (seconds to
 * minutes), so durable storage isn't worth the cost in v1.
 *
 * Multi-instance gateway deployments will need a Redis-backed swap for
 * this service when we get there; the interface stays the same so the
 * swap is local.
 */

import { Signal } from '@agentguard/core-schema';
import { Logger } from 'pino';

interface AgentState {
  lastSeen: number;
  callCount: number;
  hasCritical: boolean;
  criticalCategories: Set<string>;
}

interface SessionState {
  agents: Map<string, AgentState>;
  lastActivity: number;
}

export interface InspectResult {
  /** Other agent_ids present in the same session (not the current agent). */
  readonly otherAgents: ReadonlyArray<string>;
  /** Subset of otherAgents whose calls have produced critical signals. */
  readonly otherAgentsWithCritical: ReadonlyArray<{
    agentId: string;
    criticalCategories: ReadonlyArray<string>;
  }>;
  /** Distinct agent count in this session including the current one. */
  readonly sessionAgentCount: number;
}

export interface CrossAgentCorrelatorOptions {
  /** Max live sessions before LRU eviction. Default 4096. */
  maxSessions?: number;
  /** Inactivity TTL (ms) before a session is forgotten. Default 1h. */
  sessionTtlMs?: number;
  logger?: Logger;
}

export class CrossAgentCorrelatorService {
  private sessions = new Map<string, SessionState>();
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;
  private readonly logger?: Logger;

  constructor(opts: CrossAgentCorrelatorOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 4096;
    this.sessionTtlMs = opts.sessionTtlMs ?? 60 * 60 * 1000;
    this.logger = opts.logger;
  }

  /** Record the outcome of an evaluation. Called once per request after
   *  the detector chain runs. Idempotent for the same (orgId, sessionId,
   *  agentId, signal set) but accumulates over calls. */
  observe(opts: {
    orgId: string;
    sessionId?: string;
    agentId: string;
    signals: ReadonlyArray<Signal>;
  }): void {
    if (!opts.sessionId) return;
    this.pruneExpired();

    const key = sessionKey(opts.orgId, opts.sessionId);
    const session = this.sessions.get(key) ?? { agents: new Map(), lastActivity: 0 };
    const prior = session.agents.get(opts.agentId) ?? {
      lastSeen: 0, callCount: 0, hasCritical: false, criticalCategories: new Set<string>(),
    };
    prior.lastSeen = Date.now();
    prior.callCount += 1;
    for (const s of opts.signals) {
      if (s.severity === 'critical') {
        prior.hasCritical = true;
        prior.criticalCategories.add(s.category);
      }
    }
    session.agents.set(opts.agentId, prior);
    session.lastActivity = Date.now();
    this.sessions.set(key, session);

    if (this.sessions.size > this.maxSessions) this.evictOldest();
  }

  inspect(opts: { orgId: string; sessionId?: string; currentAgentId: string }): InspectResult {
    if (!opts.sessionId) return { otherAgents: [], otherAgentsWithCritical: [], sessionAgentCount: 1 };
    const key = sessionKey(opts.orgId, opts.sessionId);
    const session = this.sessions.get(key);
    if (!session) return { otherAgents: [], otherAgentsWithCritical: [], sessionAgentCount: 1 };

    const others: string[] = [];
    const flagged: { agentId: string; criticalCategories: string[] }[] = [];
    for (const [aid, state] of session.agents) {
      if (aid === opts.currentAgentId) continue;
      others.push(aid);
      if (state.hasCritical) {
        flagged.push({ agentId: aid, criticalCategories: [...state.criticalCategories] });
      }
    }
    return {
      otherAgents: others,
      otherAgentsWithCritical: flagged,
      sessionAgentCount: session.agents.size + (session.agents.has(opts.currentAgentId) ? 0 : 1),
    };
  }

  /** Test / inspection helper. */
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
