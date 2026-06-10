/**
 * TracesStore — highest write-volume table in AEGIS.
 *
 * Every tool call lands as one row. On a busy tenant that's hundreds
 * per second. The Postgres adapter follows the AuditLogStore pattern:
 * the producer-side `insert()` enqueues into a buffered batch and a
 * periodic flush emits a single multi-row INSERT. SDK ingestion returns
 * 201 immediately — never blocks on the DB.
 *
 * What's intentionally NOT in this v1 store:
 *   - The full query surface of TraceService (cost stats, eval stats,
 *     session aggregations) — we expose `list()` + `get()` so the
 *     Postgres-backend deploy can read its own rows; richer queries
 *     stay on the existing better-sqlite3 path until each report is
 *     migrated individually. The runbook documents the staged approach.
 *   - PII redaction / integrity-hash recomputation — those live in
 *     TraceService and stay there; the store is pure persistence.
 *
 * Why we keep some optional fields nullable instead of strict-typed
 * here: traces accrete columns over time (model, cost_usd, score,
 * feedback, pii_detected, etc.). We list every column once in the
 * schema migration; the store API takes a typed payload that maps onto
 * them. New columns get added by extending the TraceInsert interface +
 * the migration array — no breaking change to callers.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface TraceRow {
  trace_id: string;
  parent_trace_id: string | null;
  agent_id: string;
  org_id: string | null;
  timestamp: string;
  sequence_number: number;
  input_context: string;
  thought_chain: string;
  tool_call: string;
  observation: string;
  integrity_hash: string;
  previous_hash: string | null;
  signature: string | null;
  safety_validation: string | null;
  approval_status: string | null;
  approved_by: string | null;
  environment: string;
  version: string;
  tags: string | null;
  // Accreted columns — all optional/nullable for forward compat.
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  score: number | null;
  score_label: string | null;
  feedback: string | null;
  scored_by: string | null;
  scored_at: string | null;
  session_id: string | null;
  pii_detected: number | null;
  tool_category: string | null;
  risk_signals: string | null;
  blocked: number | null;
  block_reason: string | null;
  anomaly_score: number | null;
  anomaly_signals: string | null;
  content_hash: string | null;
  created_at: string;
}

export interface TraceInsert {
  trace_id: string;
  parent_trace_id?: string | null;
  agent_id: string;
  org_id?: string | null;
  timestamp: string;
  sequence_number: number;
  input_context: string;
  thought_chain: string;
  tool_call: string;
  observation: string;
  integrity_hash: string;
  previous_hash?: string | null;
  signature?: string | null;
  safety_validation?: string | null;
  approval_status?: string | null;
  approved_by?: string | null;
  environment: string;
  version: string;
  tags?: string | null;
  // Accreted columns
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  session_id?: string | null;
  pii_detected?: number | null;
  tool_category?: string | null;
  risk_signals?: string | null;
  blocked?: number | null;
  block_reason?: string | null;
  anomaly_score?: number | null;
  anomaly_signals?: string | null;
  content_hash?: string | null;
}

export interface TraceListOpts {
  agent_id?: string;
  parent_trace_id?: string;
  session_id?: string;
  approval_status?: string;
  blocked?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  /** Order column (whitelisted). Defaults to `timestamp DESC`. */
  orderBy?: 'timestamp' | 'created_at' | 'sequence_number';
  orderDir?: 'ASC' | 'DESC';
}

/** Field-level update for the rare patch surfaces (score / approval /
 *  block annotation). Keys must be in the column whitelist below. */
export interface TraceUpdate {
  approval_status?: string;
  approved_by?: string;
  score?: number;
  score_label?: string;
  feedback?: string;
  scored_by?: string;
  scored_at?: string;
  blocked?: number;
  block_reason?: string;
}

const UPDATE_COLS = new Set([
  'approval_status', 'approved_by', 'score', 'score_label',
  'feedback', 'scored_by', 'scored_at', 'blocked', 'block_reason',
]);

const ORDER_COLS = new Set(['timestamp', 'created_at', 'sequence_number']);

export interface TracesStore {
  init(): Promise<void>;
  /** Enqueue a row. Sync on Sqlite (writes immediately); async-batched
   *  on Postgres. Callers MUST NOT await — fire-and-forget semantics. */
  insert(row: TraceInsert): void;
  /** Returns rows scoped to the org (or all, when no orgId given —
   *  operator-level only). */
  list(orgId: string | null, opts: TraceListOpts): Promise<{ entries: TraceRow[]; total: number }>;
  get(trace_id: string): Promise<TraceRow | null>;
  update(trace_id: string, patch: TraceUpdate): Promise<boolean>;
  /** Force pending writes to flush. Tests / shutdown use this. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

const SQLITE_INSERT_COLS = [
  'trace_id', 'parent_trace_id', 'agent_id', 'org_id',
  'timestamp', 'sequence_number',
  'input_context', 'thought_chain', 'tool_call', 'observation',
  'integrity_hash', 'previous_hash', 'signature',
  'safety_validation', 'approval_status', 'approved_by',
  'environment', 'version', 'tags',
  'model', 'input_tokens', 'output_tokens', 'cost_usd',
  'session_id', 'pii_detected',
  'tool_category', 'risk_signals',
  'blocked', 'block_reason',
  'anomaly_score', 'anomaly_signals', 'content_hash',
];

export class SqliteTracesStore implements TracesStore {
  private insertStmt: Database.Statement | null = null;

  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT UNIQUE NOT NULL,
        parent_trace_id TEXT,
        agent_id TEXT NOT NULL,
        org_id TEXT,
        timestamp TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        input_context TEXT NOT NULL,
        thought_chain TEXT NOT NULL,
        tool_call TEXT NOT NULL,
        observation TEXT NOT NULL,
        integrity_hash TEXT NOT NULL,
        previous_hash TEXT,
        signature TEXT,
        safety_validation TEXT,
        approval_status TEXT,
        approved_by TEXT,
        environment TEXT NOT NULL,
        version TEXT NOT NULL,
        tags TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
        score INTEGER, score_label TEXT, feedback TEXT, scored_by TEXT, scored_at TEXT,
        session_id TEXT, pii_detected INTEGER,
        tool_category TEXT, risk_signals TEXT,
        blocked INTEGER, block_reason TEXT,
        anomaly_score REAL, anomaly_signals TEXT, content_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_traces_agent     ON traces(agent_id);
      CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp);
      CREATE INDEX IF NOT EXISTS idx_traces_parent    ON traces(parent_trace_id);
      CREATE INDEX IF NOT EXISTS idx_traces_approval  ON traces(approval_status);
      CREATE INDEX IF NOT EXISTS idx_traces_session   ON traces(session_id);
      CREATE INDEX IF NOT EXISTS idx_traces_org_ts    ON traces(org_id, timestamp DESC);
    `);
    // Forward-compat: ALTER best-effort for legacy DBs missing accreted cols.
    for (const col of ['org_id', 'model', 'input_tokens', 'output_tokens', 'cost_usd',
                       'score', 'score_label', 'feedback', 'scored_by', 'scored_at',
                       'session_id', 'pii_detected', 'tool_category', 'risk_signals',
                       'blocked', 'block_reason', 'anomaly_score', 'anomaly_signals',
                       'content_hash']) {
      try {
        const type = ['input_tokens', 'output_tokens', 'score', 'pii_detected', 'blocked'].includes(col) ? 'INTEGER'
                    : ['cost_usd', 'anomaly_score'].includes(col) ? 'REAL' : 'TEXT';
        this.db.exec(`ALTER TABLE traces ADD COLUMN ${col} ${type}`);
      } catch { /* exists */ }
    }
    this.insertStmt = this.db.prepare(
      `INSERT INTO traces (${SQLITE_INSERT_COLS.join(', ')})
       VALUES (${SQLITE_INSERT_COLS.map(() => '?').join(', ')})`,
    );
  }

  insert(r: TraceInsert): void {
    if (!this.insertStmt) throw new Error('TracesStore: init() must be called before insert()');
    this.insertStmt.run(
      r.trace_id, r.parent_trace_id ?? null, r.agent_id, r.org_id ?? null,
      r.timestamp, r.sequence_number,
      r.input_context, r.thought_chain, r.tool_call, r.observation,
      r.integrity_hash, r.previous_hash ?? null, r.signature ?? null,
      r.safety_validation ?? null, r.approval_status ?? null, r.approved_by ?? null,
      r.environment, r.version, r.tags ?? null,
      r.model ?? null, r.input_tokens ?? null, r.output_tokens ?? null, r.cost_usd ?? null,
      r.session_id ?? null, r.pii_detected ?? null,
      r.tool_category ?? null, r.risk_signals ?? null,
      r.blocked ?? null, r.block_reason ?? null,
      r.anomaly_score ?? null, r.anomaly_signals ?? null, r.content_hash ?? null,
    );
  }

  async list(orgId: string | null, opts: TraceListOpts): Promise<{ entries: TraceRow[]; total: number }> {
    const { where, params } = this.buildWhere(orgId, opts);
    const total  = (this.db.prepare(`SELECT COUNT(*) AS n FROM traces ${where}`).get(...params) as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const order  = ORDER_COLS.has(opts.orderBy ?? 'timestamp') ? (opts.orderBy ?? 'timestamp') : 'timestamp';
    const dir    = opts.orderDir === 'ASC' ? 'ASC' : 'DESC';
    const entries = this.db.prepare(
      `SELECT * FROM traces ${where} ORDER BY ${order} ${dir} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as TraceRow[];
    return { entries, total };
  }

  async get(trace_id: string): Promise<TraceRow | null> {
    return (this.db.prepare(`SELECT * FROM traces WHERE trace_id = ?`).get(trace_id) as any) ?? null;
  }

  async update(trace_id: string, patch: TraceUpdate): Promise<boolean> {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!UPDATE_COLS.has(k)) continue;
      sets.push(`${k} = ?`);
      args.push(v as any);
    }
    if (sets.length === 0) return false;
    const r = this.db.prepare(
      `UPDATE traces SET ${sets.join(', ')} WHERE trace_id = ?`,
    ).run(...args, trace_id);
    return r.changes > 0;
  }

  private buildWhere(orgId: string | null, opts: TraceListOpts): { where: string; params: any[] } {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    if (orgId !== null)     { conds.push('org_id = ?');       params.push(orgId); }
    if (opts.agent_id)        { conds.push('agent_id = ?');        params.push(opts.agent_id); }
    if (opts.parent_trace_id) { conds.push('parent_trace_id = ?'); params.push(opts.parent_trace_id); }
    if (opts.session_id)      { conds.push('session_id = ?');      params.push(opts.session_id); }
    if (opts.approval_status) { conds.push('approval_status = ?'); params.push(opts.approval_status); }
    if (typeof opts.blocked === 'boolean') { conds.push('blocked = ?'); params.push(opts.blocked ? 1 : 0); }
    if (opts.from)            { conds.push('timestamp >= ?');       params.push(opts.from); }
    if (opts.to)              { conds.push('timestamp <= ?');       params.push(opts.to); }
    return { where: 'WHERE ' + conds.join(' AND '), params };
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS traces (
    id BIGSERIAL PRIMARY KEY,
    trace_id TEXT UNIQUE NOT NULL,
    parent_trace_id TEXT,
    agent_id TEXT NOT NULL,
    org_id TEXT,
    timestamp TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    input_context TEXT NOT NULL,
    thought_chain TEXT NOT NULL,
    tool_call TEXT NOT NULL,
    observation TEXT NOT NULL,
    integrity_hash TEXT NOT NULL,
    previous_hash TEXT,
    signature TEXT,
    safety_validation TEXT,
    approval_status TEXT,
    approved_by TEXT,
    environment TEXT NOT NULL,
    version TEXT NOT NULL,
    tags TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd DOUBLE PRECISION,
    score INTEGER, score_label TEXT, feedback TEXT, scored_by TEXT, scored_at TEXT,
    session_id TEXT, pii_detected INTEGER,
    tool_category TEXT, risk_signals TEXT,
    blocked INTEGER, block_reason TEXT,
    anomaly_score DOUBLE PRECISION, anomaly_signals TEXT, content_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_traces_agent     ON traces(agent_id);
  CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp);
  CREATE INDEX IF NOT EXISTS idx_traces_parent    ON traces(parent_trace_id);
  CREATE INDEX IF NOT EXISTS idx_traces_approval  ON traces(approval_status);
  CREATE INDEX IF NOT EXISTS idx_traces_session   ON traces(session_id);
  CREATE INDEX IF NOT EXISTS idx_traces_org_ts    ON traces(org_id, timestamp DESC);
`;

export class PostgresTracesStore implements TracesStore {
  private pool: Pool;
  private buffer: TraceInsert[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushIntervalMs: number;
  private maxBatch: number;
  private flushing: Promise<void> | null = null;

  constructor(pool: Pool, opts: { flushIntervalMs?: number; maxBatch?: number } = {}) {
    this.pool = pool;
    this.flushIntervalMs = opts.flushIntervalMs ?? 150;
    this.maxBatch        = opts.maxBatch ?? 500;
  }

  async init(): Promise<void> {
    await this.pool.query(PG_SCHEMA);
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => { this.flush().catch(() => {}); }, this.flushIntervalMs);
      if (typeof (this.flushTimer as any).unref === 'function') (this.flushTimer as any).unref();
    }
  }

  insert(r: TraceInsert): void {
    this.buffer.push(r);
    if (this.buffer.length >= this.maxBatch) this.flush().catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    this.flushing = (async () => {
      try {
        const cols = SQLITE_INSERT_COLS;
        const values: any[] = [];
        const groups: string[] = [];
        for (const r of batch) {
          const baseIdx = values.length;
          values.push(
            r.trace_id, r.parent_trace_id ?? null, r.agent_id, r.org_id ?? null,
            r.timestamp, r.sequence_number,
            r.input_context, r.thought_chain, r.tool_call, r.observation,
            r.integrity_hash, r.previous_hash ?? null, r.signature ?? null,
            r.safety_validation ?? null, r.approval_status ?? null, r.approved_by ?? null,
            r.environment, r.version, r.tags ?? null,
            r.model ?? null, r.input_tokens ?? null, r.output_tokens ?? null, r.cost_usd ?? null,
            r.session_id ?? null, r.pii_detected ?? null,
            r.tool_category ?? null, r.risk_signals ?? null,
            r.blocked ?? null, r.block_reason ?? null,
            r.anomaly_score ?? null, r.anomaly_signals ?? null, r.content_hash ?? null,
          );
          groups.push('(' + cols.map((_, i) => `$${baseIdx + i + 1}`).join(', ') + ')');
        }
        await this.pool.query(
          `INSERT INTO traces (${cols.join(', ')}) VALUES ${groups.join(', ')} ON CONFLICT (trace_id) DO NOTHING`,
          values,
        );
      } finally { this.flushing = null; }
    })();
    return this.flushing;
  }

  async list(orgId: string | null, opts: TraceListOpts): Promise<{ entries: TraceRow[]; total: number }> {
    await this.flush();
    const { where, params } = this.buildWhere(orgId, opts);
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM traces ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const order  = ORDER_COLS.has(opts.orderBy ?? 'timestamp') ? (opts.orderBy ?? 'timestamp') : 'timestamp';
    const dir    = opts.orderDir === 'ASC' ? 'ASC' : 'DESC';
    const r = await this.pool.query(
      `SELECT * FROM traces ${where} ORDER BY ${order} ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as TraceRow[], total };
  }

  async get(trace_id: string): Promise<TraceRow | null> {
    await this.flush();
    const r = await this.pool.query(`SELECT * FROM traces WHERE trace_id = $1`, [trace_id]);
    return (r.rows[0] as any) ?? null;
  }

  async update(trace_id: string, patch: TraceUpdate): Promise<boolean> {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!UPDATE_COLS.has(k)) continue;
      sets.push(`${k} = $${args.length + 1}`);
      args.push(v as any);
    }
    if (sets.length === 0) return false;
    args.push(trace_id);
    const r = await this.pool.query(
      `UPDATE traces SET ${sets.join(', ')} WHERE trace_id = $${args.length}`,
      args,
    );
    return (r.rowCount ?? 0) > 0;
  }

  private buildWhere(orgId: string | null, opts: TraceListOpts): { where: string; params: any[] } {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    const next = () => `$${params.length + 1}`;
    if (orgId !== null)     { conds.push(`org_id = ${next()}`);       params.push(orgId); }
    if (opts.agent_id)        { conds.push(`agent_id = ${next()}`);        params.push(opts.agent_id); }
    if (opts.parent_trace_id) { conds.push(`parent_trace_id = ${next()}`); params.push(opts.parent_trace_id); }
    if (opts.session_id)      { conds.push(`session_id = ${next()}`);      params.push(opts.session_id); }
    if (opts.approval_status) { conds.push(`approval_status = ${next()}`); params.push(opts.approval_status); }
    if (typeof opts.blocked === 'boolean') { conds.push(`blocked = ${next()}`); params.push(opts.blocked ? 1 : 0); }
    if (opts.from)            { conds.push(`timestamp >= ${next()}`);       params.push(opts.from); }
    if (opts.to)              { conds.push(`timestamp <= ${next()}`);       params.push(opts.to); }
    return { where: 'WHERE ' + conds.join(' AND '), params };
  }

  async close(): Promise<void> {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    await this.flush().catch(() => {});
    await this.pool.end().catch(() => {});
  }
}
