/**
 * ApprovalsStore — human-in-the-loop approval lifecycle.
 *
 * State machine:
 *   PENDING  ─approve→  APPROVED
 *   PENDING  ─reject→   REJECTED
 *   PENDING  ─expire→   EXPIRED
 *
 * One row per trace_id (UNIQUE). Cockpit lists PENDING; SDK polls
 * for state transitions; reviewer hits approve/reject.
 *
 * Indices match the cockpit's two access patterns:
 *   - "show me pending approvals about to expire" → (status, expires_at)
 *   - "show me an agent's history"                → (agent_id, status)
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ApprovalRow {
  id: string;
  trace_id: string;
  agent_id: string;
  tool_name: string;
  risk_level: string;
  status: ApprovalStatus;
  approver: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  expires_at: string;
}

export interface ApprovalInsert {
  id: string;
  trace_id: string;
  agent_id: string;
  tool_name: string;
  risk_level: string;
  expires_at: string;     // ISO
}

export interface ApprovalListOpts {
  agent_id?: string;
  status?: ApprovalStatus;
  active_only?: boolean;       // status=PENDING AND not expired
  limit?: number;
  offset?: number;
}

export interface ApprovalsStore {
  init(): Promise<void>;
  insert(row: ApprovalInsert): Promise<void>;
  get(id: string): Promise<ApprovalRow | null>;
  getByTraceId(trace_id: string): Promise<ApprovalRow | null>;
  list(opts: ApprovalListOpts): Promise<{ entries: ApprovalRow[]; total: number }>;
  approve(id: string, approver: string): Promise<boolean>;
  reject(id: string, approver: string, reason: string): Promise<boolean>;
  /** Mark every PENDING row whose expires_at < now as EXPIRED.
   *  Returns the number transitioned. Janitor calls this periodically. */
  expireDue(nowIso: string): Promise<number>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteApprovalsStore implements ApprovalsStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        trace_id TEXT UNIQUE NOT NULL,
        agent_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        approver TEXT,
        approved_at TEXT,
        rejection_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_apv_status   ON approvals(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_apv_agent    ON approvals(agent_id, status);
    `);
  }

  async insert(r: ApprovalInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO approvals (id, trace_id, agent_id, tool_name, risk_level, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.trace_id, r.agent_id, r.tool_name, r.risk_level, r.expires_at);
  }

  async get(id: string): Promise<ApprovalRow | null> {
    return (this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as any) ?? null;
  }

  async getByTraceId(trace_id: string): Promise<ApprovalRow | null> {
    return (this.db.prepare(`SELECT * FROM approvals WHERE trace_id = ?`).get(trace_id) as any) ?? null;
  }

  async list(opts: ApprovalListOpts): Promise<{ entries: ApprovalRow[]; total: number }> {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    if (opts.agent_id) { conds.push('agent_id = ?'); params.push(opts.agent_id); }
    if (opts.status)   { conds.push('status = ?');   params.push(opts.status); }
    if (opts.active_only) {
      conds.push(`status = 'PENDING' AND datetime(expires_at) > datetime('now')`);
    }
    const where = 'WHERE ' + conds.join(' AND ');
    const total  = (this.db.prepare(`SELECT COUNT(*) AS n FROM approvals ${where}`).get(...params) as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const entries = this.db.prepare(
      `SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as ApprovalRow[];
    return { entries, total };
  }

  async approve(id: string, approver: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE approvals SET status = 'APPROVED', approver = ?, approved_at = datetime('now')
       WHERE id = ? AND status = 'PENDING'`,
    ).run(approver, id);
    return r.changes > 0;
  }

  async reject(id: string, approver: string, reason: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE approvals SET status = 'REJECTED', approver = ?, approved_at = datetime('now'), rejection_reason = ?
       WHERE id = ? AND status = 'PENDING'`,
    ).run(approver, reason, id);
    return r.changes > 0;
  }

  async expireDue(_nowIso: string): Promise<number> {
    const r = this.db.prepare(
      `UPDATE approvals SET status = 'EXPIRED'
       WHERE status = 'PENDING' AND datetime(expires_at) <= datetime('now')`,
    ).run();
    return r.changes;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    trace_id TEXT UNIQUE NOT NULL,
    agent_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    approver TEXT,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_apv_status   ON approvals(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_apv_agent    ON approvals(agent_id, status);
`;

export class PostgresApprovalsStore implements ApprovalsStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: ApprovalInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO approvals (id, trace_id, agent_id, tool_name, risk_level, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.id, r.trace_id, r.agent_id, r.tool_name, r.risk_level, r.expires_at],
    );
  }

  async get(id: string): Promise<ApprovalRow | null> {
    const r = await this.pool.query(`SELECT * FROM approvals WHERE id = $1`, [id]);
    return (r.rows[0] as any) ?? null;
  }

  async getByTraceId(trace_id: string): Promise<ApprovalRow | null> {
    const r = await this.pool.query(`SELECT * FROM approvals WHERE trace_id = $1`, [trace_id]);
    return (r.rows[0] as any) ?? null;
  }

  async list(opts: ApprovalListOpts): Promise<{ entries: ApprovalRow[]; total: number }> {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    const next = () => `$${params.length + 1}`;
    if (opts.agent_id) { conds.push(`agent_id = ${next()}`); params.push(opts.agent_id); }
    if (opts.status)   { conds.push(`status = ${next()}`);   params.push(opts.status); }
    if (opts.active_only) {
      conds.push(`status = 'PENDING' AND expires_at > NOW()`);
    }
    const where = 'WHERE ' + conds.join(' AND ');
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM approvals ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const r = await this.pool.query(
      `SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as ApprovalRow[], total };
  }

  async approve(id: string, approver: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE approvals SET status = 'APPROVED', approver = $1, approved_at = NOW()
       WHERE id = $2 AND status = 'PENDING'`,
      [approver, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async reject(id: string, approver: string, reason: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE approvals SET status = 'REJECTED', approver = $1, approved_at = NOW(), rejection_reason = $2
       WHERE id = $3 AND status = 'PENDING'`,
      [approver, reason, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async expireDue(_nowIso: string): Promise<number> {
    const r = await this.pool.query(
      `UPDATE approvals SET status = 'EXPIRED'
       WHERE status = 'PENDING' AND expires_at <= NOW()`,
    );
    return r.rowCount ?? 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
