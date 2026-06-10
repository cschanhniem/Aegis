/**
 * AnomalyEventsStore — every Layer 2 anomaly detection above threshold.
 *
 * Indexed by (agent_id, created_at DESC) for the cockpit "this agent's
 * anomaly history" panel, plus a separate index on composite_score
 * so "top anomalies in window" queries hit an index. Lower write
 * volume than traces (only above-threshold events land here), so
 * direct INSERT without batching is fine.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface AnomalyEventRow {
  id: number;
  agent_id: string;
  trace_id: string | null;
  check_id: string | null;
  composite_score: number;
  decision: string;
  signals: string;
  created_at: string;
}

export interface AnomalyEventInsert {
  agent_id: string;
  trace_id?: string | null;
  check_id?: string | null;
  composite_score: number;
  decision: string;
  signals: string;
}

export interface AnomalyEventListOpts {
  agent_id?: string;
  min_score?: number;
  decision?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AnomalyEventsStore {
  init(): Promise<void>;
  insert(row: AnomalyEventInsert): Promise<void>;
  list(opts: AnomalyEventListOpts): Promise<{ entries: AnomalyEventRow[]; total: number }>;
  /** Top-N highest-score events in a window. Used by the cockpit
   *  "anomaly leaderboard" tile. */
  topByScore(sinceIso: string, limit: number): Promise<AnomalyEventRow[]>;
  countByAgentSince(agentId: string, sinceIso: string): Promise<number>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteAnomalyEventsStore implements AnomalyEventsStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS anomaly_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        trace_id TEXT,
        check_id TEXT,
        composite_score REAL NOT NULL,
        decision TEXT NOT NULL,
        signals TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ae_agent    ON anomaly_events(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_score    ON anomaly_events(composite_score DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_decision ON anomaly_events(decision);
    `);
  }

  async insert(r: AnomalyEventInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO anomaly_events (agent_id, trace_id, check_id, composite_score, decision, signals)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.agent_id, r.trace_id ?? null, r.check_id ?? null, r.composite_score, r.decision, r.signals);
  }

  async list(opts: AnomalyEventListOpts): Promise<{ entries: AnomalyEventRow[]; total: number }> {
    const { where, params } = this.buildWhere(opts);
    const total  = (this.db.prepare(`SELECT COUNT(*) AS n FROM anomaly_events ${where}`).get(...params) as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const entries = this.db.prepare(
      `SELECT * FROM anomaly_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as AnomalyEventRow[];
    return { entries, total };
  }

  async topByScore(sinceIso: string, limit: number): Promise<AnomalyEventRow[]> {
    return this.db.prepare(
      `SELECT * FROM anomaly_events WHERE datetime(created_at) >= datetime(?)
       ORDER BY composite_score DESC LIMIT ?`,
    ).all(sinceIso, Math.min(limit, 500)) as AnomalyEventRow[];
  }

  async countByAgentSince(agentId: string, sinceIso: string): Promise<number> {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n FROM anomaly_events WHERE agent_id = ? AND datetime(created_at) >= datetime(?)`,
    ).get(agentId, sinceIso) as any;
    return r?.n ?? 0;
  }

  private buildWhere(opts: AnomalyEventListOpts): { where: string; params: any[] } {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    if (opts.agent_id)  { conds.push('agent_id = ?');  params.push(opts.agent_id); }
    if (opts.decision)  { conds.push('decision = ?');  params.push(opts.decision); }
    if (opts.min_score !== undefined) { conds.push('composite_score >= ?'); params.push(opts.min_score); }
    if (opts.from)      { conds.push('created_at >= ?'); params.push(opts.from); }
    if (opts.to)        { conds.push('created_at <= ?'); params.push(opts.to); }
    return { where: 'WHERE ' + conds.join(' AND '), params };
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS anomaly_events (
    id BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    trace_id TEXT,
    check_id TEXT,
    composite_score DOUBLE PRECISION NOT NULL,
    decision TEXT NOT NULL,
    signals TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_ae_agent    ON anomaly_events(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ae_score    ON anomaly_events(composite_score DESC);
  CREATE INDEX IF NOT EXISTS idx_ae_decision ON anomaly_events(decision);
`;

export class PostgresAnomalyEventsStore implements AnomalyEventsStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: AnomalyEventInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO anomaly_events (agent_id, trace_id, check_id, composite_score, decision, signals)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.agent_id, r.trace_id ?? null, r.check_id ?? null, r.composite_score, r.decision, r.signals],
    );
  }

  async list(opts: AnomalyEventListOpts): Promise<{ entries: AnomalyEventRow[]; total: number }> {
    const { where, params } = this.buildWhere(opts);
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM anomaly_events ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const r = await this.pool.query(
      `SELECT * FROM anomaly_events ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as AnomalyEventRow[], total };
  }

  async topByScore(sinceIso: string, limit: number): Promise<AnomalyEventRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM anomaly_events WHERE created_at >= $1 ORDER BY composite_score DESC LIMIT $2`,
      [sinceIso, Math.min(limit, 500)],
    );
    return r.rows as AnomalyEventRow[];
  }

  async countByAgentSince(agentId: string, sinceIso: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM anomaly_events WHERE agent_id = $1 AND created_at >= $2`,
      [agentId, sinceIso],
    );
    return (r.rows[0] as any)?.n ?? 0;
  }

  private buildWhere(opts: AnomalyEventListOpts): { where: string; params: any[] } {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    const next = () => `$${params.length + 1}`;
    if (opts.agent_id)  { conds.push(`agent_id = ${next()}`);  params.push(opts.agent_id); }
    if (opts.decision)  { conds.push(`decision = ${next()}`);  params.push(opts.decision); }
    if (opts.min_score !== undefined) { conds.push(`composite_score >= ${next()}`); params.push(opts.min_score); }
    if (opts.from)      { conds.push(`created_at >= ${next()}`); params.push(opts.from); }
    if (opts.to)        { conds.push(`created_at <= ${next()}`); params.push(opts.to); }
    return { where: 'WHERE ' + conds.join(' AND '), params };
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
