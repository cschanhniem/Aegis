/**
 * ViolationsStore — records when a policy block fired against an
 * agent's tool call. Lower write rate than traces (only blocked
 * calls land here), so the Postgres adapter uses a direct INSERT
 * instead of batching.
 *
 * Per-agent + per-policy aggregations drive the cockpit violations
 * tab + the kill-switch threshold logic. Indices on (agent_id,
 * created_at) and (policy_id, created_at) match those access patterns.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface ViolationRow {
  id: number;
  agent_id: string;
  policy_id: string;
  trace_id: string;
  violation_type: string;
  details: string | null;
  created_at: string;
}

export interface ViolationInsert {
  agent_id: string;
  policy_id: string;
  trace_id: string;
  violation_type: string;
  details?: string | null;
}

export interface ViolationListOpts {
  agent_id?: string;
  policy_id?: string;
  trace_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ViolationsStore {
  init(): Promise<void>;
  insert(row: ViolationInsert): Promise<void>;
  list(opts: ViolationListOpts): Promise<{ entries: ViolationRow[]; total: number }>;
  /** Count of violations for an agent within the given window. Used
   *  by the kill-switch threshold check (N violations in T minutes
   *  → auto-revoke). */
  countByAgentSince(agentId: string, sinceIso: string): Promise<number>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteViolationsStore implements ViolationsStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_vio_agent  ON violations(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vio_policy ON violations(policy_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vio_trace  ON violations(trace_id);
    `);
  }

  async insert(r: ViolationInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO violations (agent_id, policy_id, trace_id, violation_type, details) VALUES (?, ?, ?, ?, ?)`,
    ).run(r.agent_id, r.policy_id, r.trace_id, r.violation_type, r.details ?? null);
  }

  async list(opts: ViolationListOpts): Promise<{ entries: ViolationRow[]; total: number }> {
    const { where, params } = this.buildWhere(opts);
    const total  = (this.db.prepare(`SELECT COUNT(*) AS n FROM violations ${where}`).get(...params) as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const entries = this.db.prepare(
      `SELECT * FROM violations ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as ViolationRow[];
    return { entries, total };
  }

  async countByAgentSince(agentId: string, sinceIso: string): Promise<number> {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n FROM violations WHERE agent_id = ? AND datetime(created_at) >= datetime(?)`,
    ).get(agentId, sinceIso) as any;
    return r?.n ?? 0;
  }

  private buildWhere(opts: ViolationListOpts): { where: string; params: any[] } {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    if (opts.agent_id)  { conds.push('agent_id = ?');  params.push(opts.agent_id); }
    if (opts.policy_id) { conds.push('policy_id = ?'); params.push(opts.policy_id); }
    if (opts.trace_id)  { conds.push('trace_id = ?');  params.push(opts.trace_id); }
    if (opts.from)      { conds.push('created_at >= ?'); params.push(opts.from); }
    if (opts.to)        { conds.push('created_at <= ?'); params.push(opts.to); }
    return { where: 'WHERE ' + conds.join(' AND '), params };
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS violations (
    id BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    violation_type TEXT NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_vio_agent  ON violations(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vio_policy ON violations(policy_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vio_trace  ON violations(trace_id);
`;

export class PostgresViolationsStore implements ViolationsStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: ViolationInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO violations (agent_id, policy_id, trace_id, violation_type, details) VALUES ($1, $2, $3, $4, $5)`,
      [r.agent_id, r.policy_id, r.trace_id, r.violation_type, r.details ?? null],
    );
  }

  async list(opts: ViolationListOpts): Promise<{ entries: ViolationRow[]; total: number }> {
    const { where, params } = this.buildWhere(opts);
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM violations ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const r = await this.pool.query(
      `SELECT * FROM violations ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as ViolationRow[], total };
  }

  async countByAgentSince(agentId: string, sinceIso: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM violations WHERE agent_id = $1 AND created_at >= $2`,
      [agentId, sinceIso],
    );
    return (r.rows[0] as any)?.n ?? 0;
  }

  private buildWhere(opts: ViolationListOpts): { where: string; params: any[] } {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    const next = () => `$${params.length + 1}`;
    if (opts.agent_id)  { conds.push(`agent_id = ${next()}`);  params.push(opts.agent_id); }
    if (opts.policy_id) { conds.push(`policy_id = ${next()}`); params.push(opts.policy_id); }
    if (opts.trace_id)  { conds.push(`trace_id = ${next()}`);  params.push(opts.trace_id); }
    if (opts.from)      { conds.push(`created_at >= ${next()}`); params.push(opts.from); }
    if (opts.to)        { conds.push(`created_at <= ${next()}`); params.push(opts.to); }
    return { where: 'WHERE ' + conds.join(' AND '), params };
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
