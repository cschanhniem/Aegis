/**
 * PendingChecksStore — blocking-mode short-lived pending decisions.
 *
 * Lifecycle:
 *   1. /api/v1/check (blocking=true, HIGH/CRITICAL risk) → INSERT
 *      row with decision='pending', expires_at = now + N min.
 *   2. SDK polls GET /api/v1/check/:id/decision → returns the row's
 *      current `decision` value.
 *   3. Cockpit reviewer hits PATCH /api/v1/check/:id with allow/block.
 *   4. On expiry (without decision), the janitor sets decision='block'
 *      with decided_by='timeout'.
 *
 * Rows are short-lived (default TTL ~5 min). After resolution the
 * cockpit "review history" still references them, but a periodic
 * janitor purges rows older than a configurable retention.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export type CheckDecision = 'pending' | 'allow' | 'block';

export interface PendingCheckRow {
  check_id: string;
  agent_id: string;
  tool_name: string;
  arguments: string;        // JSON
  category: string;
  risk_level: string;
  signals: string | null;   // JSON
  violations: string | null;// JSON
  decision: CheckDecision;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string;
}

export interface PendingCheckInsert {
  check_id: string;
  agent_id: string;
  tool_name: string;
  arguments: string;
  category: string;
  risk_level: string;
  signals?: string | null;
  violations?: string | null;
  expires_at: string;
}

export interface PendingCheckListOpts {
  agent_id?: string;
  decision?: CheckDecision;
  active_only?: boolean;    // decision='pending' AND not expired
  limit?: number;
  offset?: number;
}

export interface PendingChecksStore {
  init(): Promise<void>;
  insert(row: PendingCheckInsert): Promise<void>;
  get(check_id: string): Promise<PendingCheckRow | null>;
  list(opts: PendingCheckListOpts): Promise<{ entries: PendingCheckRow[]; total: number }>;
  /** Resolve a pending check to allow/block. Returns true if the row
   *  was actually transitioned (i.e. it was still pending). */
  decide(check_id: string, decision: 'allow' | 'block', decided_by: string): Promise<boolean>;
  /** Mark expired-but-still-pending rows as block/timeout. Returns count. */
  expireDue(): Promise<number>;
  /** Purge rows older than the given cutoff for retention. */
  purgeOlderThan(beforeIso: string): Promise<number>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqlitePendingChecksStore implements PendingChecksStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_checks (
        check_id    TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        arguments   TEXT NOT NULL,
        category    TEXT NOT NULL,
        risk_level  TEXT NOT NULL,
        signals     TEXT,
        violations  TEXT,
        decision    TEXT NOT NULL DEFAULT 'pending',
        decided_by  TEXT,
        decided_at  TEXT,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pchk_decision ON pending_checks(decision, expires_at);
      CREATE INDEX IF NOT EXISTS idx_pchk_agent    ON pending_checks(agent_id, decision);
    `);
  }

  async insert(r: PendingCheckInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO pending_checks
        (check_id, agent_id, tool_name, arguments, category, risk_level, signals, violations, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.check_id, r.agent_id, r.tool_name, r.arguments,
      r.category, r.risk_level, r.signals ?? null, r.violations ?? null, r.expires_at,
    );
  }

  async get(check_id: string): Promise<PendingCheckRow | null> {
    return (this.db.prepare(`SELECT * FROM pending_checks WHERE check_id = ?`).get(check_id) as any) ?? null;
  }

  async list(opts: PendingCheckListOpts): Promise<{ entries: PendingCheckRow[]; total: number }> {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    if (opts.agent_id) { conds.push('agent_id = ?'); params.push(opts.agent_id); }
    if (opts.decision) { conds.push('decision = ?'); params.push(opts.decision); }
    if (opts.active_only) {
      conds.push(`decision = 'pending' AND datetime(expires_at) > datetime('now')`);
    }
    const where = 'WHERE ' + conds.join(' AND ');
    const total  = (this.db.prepare(`SELECT COUNT(*) AS n FROM pending_checks ${where}`).get(...params) as any).n;
    const limit  = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;
    const entries = this.db.prepare(
      `SELECT * FROM pending_checks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as PendingCheckRow[];
    return { entries, total };
  }

  async decide(check_id: string, decision: 'allow' | 'block', decided_by: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE pending_checks SET decision = ?, decided_by = ?, decided_at = datetime('now')
       WHERE check_id = ? AND decision = 'pending'`,
    ).run(decision, decided_by, check_id);
    return r.changes > 0;
  }

  async expireDue(): Promise<number> {
    const r = this.db.prepare(
      `UPDATE pending_checks SET decision = 'block', decided_by = 'timeout', decided_at = datetime('now')
       WHERE decision = 'pending' AND datetime(expires_at) <= datetime('now')`,
    ).run();
    return r.changes;
  }

  async purgeOlderThan(beforeIso: string): Promise<number> {
    const r = this.db.prepare(
      `DELETE FROM pending_checks WHERE datetime(created_at) < datetime(?)`,
    ).run(beforeIso);
    return r.changes;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pending_checks (
    check_id    TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    tool_name   TEXT NOT NULL,
    arguments   TEXT NOT NULL,
    category    TEXT NOT NULL,
    risk_level  TEXT NOT NULL,
    signals     TEXT,
    violations  TEXT,
    decision    TEXT NOT NULL DEFAULT 'pending',
    decided_by  TEXT,
    decided_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pchk_decision ON pending_checks(decision, expires_at);
  CREATE INDEX IF NOT EXISTS idx_pchk_agent    ON pending_checks(agent_id, decision);
`;

export class PostgresPendingChecksStore implements PendingChecksStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: PendingCheckInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_checks
        (check_id, agent_id, tool_name, arguments, category, risk_level, signals, violations, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        r.check_id, r.agent_id, r.tool_name, r.arguments,
        r.category, r.risk_level, r.signals ?? null, r.violations ?? null, r.expires_at,
      ],
    );
  }

  async get(check_id: string): Promise<PendingCheckRow | null> {
    const r = await this.pool.query(`SELECT * FROM pending_checks WHERE check_id = $1`, [check_id]);
    return (r.rows[0] as any) ?? null;
  }

  async list(opts: PendingCheckListOpts): Promise<{ entries: PendingCheckRow[]; total: number }> {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    const next = () => `$${params.length + 1}`;
    if (opts.agent_id) { conds.push(`agent_id = ${next()}`); params.push(opts.agent_id); }
    if (opts.decision) { conds.push(`decision = ${next()}`); params.push(opts.decision); }
    if (opts.active_only) {
      conds.push(`decision = 'pending' AND expires_at > NOW()`);
    }
    const where = 'WHERE ' + conds.join(' AND ');
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM pending_checks ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit  = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;
    const r = await this.pool.query(
      `SELECT * FROM pending_checks ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as PendingCheckRow[], total };
  }

  async decide(check_id: string, decision: 'allow' | 'block', decided_by: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pending_checks SET decision = $1, decided_by = $2, decided_at = NOW()
       WHERE check_id = $3 AND decision = 'pending'`,
      [decision, decided_by, check_id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async expireDue(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE pending_checks SET decision = 'block', decided_by = 'timeout', decided_at = NOW()
       WHERE decision = 'pending' AND expires_at <= NOW()`,
    );
    return r.rowCount ?? 0;
  }

  async purgeOlderThan(beforeIso: string): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM pending_checks WHERE created_at < $1`,
      [beforeIso],
    );
    return r.rowCount ?? 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
