/**
 * DlqStore — Dead-Letter Queue for failed rollback / compensation steps.
 *
 * Status machine:
 *   pending  → operator decision required
 *   retried  → operator hit "retry"; row stays pending until next failure
 *   dismissed → operator gave up; the row is closed
 *
 * Indices match the two ops access patterns:
 *   - "what's broken right now"  → (status, enqueued_at DESC)
 *   - "this tenant's open issues" → (org_id, status)
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export type DlqStatus = 'pending' | 'retried' | 'dismissed';

export interface DlqRow {
  id: number;
  org_id: string;
  saga_id: string | null;
  trace_id: string;
  tool_name: string;
  compensator_kind: string;
  last_error: string;
  attempts_made: number;
  planned_action: string;
  status: DlqStatus;
  enqueued_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface DlqInsert {
  org_id: string;
  saga_id?: string | null;
  trace_id: string;
  tool_name: string;
  compensator_kind: string;
  last_error: string;
  attempts_made: number;
  planned_action: string;
}

export interface DlqListOpts {
  org_id: string;
  status?: DlqStatus;
  limit?: number;
  offset?: number;
}

export interface DlqStore {
  init(): Promise<void>;
  insert(row: DlqInsert): Promise<number>;
  get(orgId: string, id: number): Promise<DlqRow | null>;
  list(opts: DlqListOpts): Promise<{ entries: DlqRow[]; total: number }>;
  /** Count of currently-pending rows per org (used by the cockpit badge
   *  and by GatewayMetricsService to publish `aegis_dlq_depth`). */
  pendingCount(orgId: string): Promise<number>;
  /** Mark a row as retried — the actual retry is performed by the
   *  caller; this just records the operator decision. */
  retry(orgId: string, id: number, resolvedBy: string, note?: string): Promise<boolean>;
  dismiss(orgId: string, id: number, resolvedBy: string, note?: string): Promise<boolean>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteDlqStore implements DlqStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compensation_dlq (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id          TEXT NOT NULL,
        saga_id         TEXT,
        trace_id        TEXT NOT NULL,
        tool_name       TEXT NOT NULL,
        compensator_kind TEXT NOT NULL,
        last_error      TEXT NOT NULL,
        attempts_made   INTEGER NOT NULL,
        planned_action  TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        enqueued_at     TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT,
        resolved_by     TEXT,
        resolution_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dlq_status  ON compensation_dlq(status, enqueued_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dlq_org     ON compensation_dlq(org_id, status);
    `);
  }

  async insert(r: DlqInsert): Promise<number> {
    const info = this.db.prepare(
      `INSERT INTO compensation_dlq
       (org_id, saga_id, trace_id, tool_name, compensator_kind, last_error, attempts_made, planned_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.org_id, r.saga_id ?? null, r.trace_id, r.tool_name,
          r.compensator_kind, r.last_error, r.attempts_made, r.planned_action);
    return info.lastInsertRowid as number;
  }

  async get(orgId: string, id: number): Promise<DlqRow | null> {
    return (this.db.prepare(`SELECT * FROM compensation_dlq WHERE id = ? AND org_id = ?`).get(id, orgId) as any) ?? null;
  }

  async list(opts: DlqListOpts): Promise<{ entries: DlqRow[]; total: number }> {
    const conds: string[] = ['org_id = ?'];
    const params: any[] = [opts.org_id];
    if (opts.status) { conds.push('status = ?'); params.push(opts.status); }
    const where = 'WHERE ' + conds.join(' AND ');
    const total  = (this.db.prepare(`SELECT COUNT(*) AS n FROM compensation_dlq ${where}`).get(...params) as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const entries = this.db.prepare(
      `SELECT * FROM compensation_dlq ${where} ORDER BY enqueued_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as DlqRow[];
    return { entries, total };
  }

  async pendingCount(orgId: string): Promise<number> {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n FROM compensation_dlq WHERE org_id = ? AND status = 'pending'`,
    ).get(orgId) as any;
    return r?.n ?? 0;
  }

  async retry(orgId: string, id: number, resolvedBy: string, note?: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE compensation_dlq SET status = 'retried', resolved_at = datetime('now'), resolved_by = ?, resolution_note = ?
       WHERE id = ? AND org_id = ? AND status = 'pending'`,
    ).run(resolvedBy, note ?? null, id, orgId);
    return r.changes > 0;
  }

  async dismiss(orgId: string, id: number, resolvedBy: string, note?: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE compensation_dlq SET status = 'dismissed', resolved_at = datetime('now'), resolved_by = ?, resolution_note = ?
       WHERE id = ? AND org_id = ? AND status = 'pending'`,
    ).run(resolvedBy, note ?? null, id, orgId);
    return r.changes > 0;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS compensation_dlq (
    id BIGSERIAL PRIMARY KEY,
    org_id          TEXT NOT NULL,
    saga_id         TEXT,
    trace_id        TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    compensator_kind TEXT NOT NULL,
    last_error      TEXT NOT NULL,
    attempts_made   INTEGER NOT NULL,
    planned_action  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT,
    resolution_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dlq_status  ON compensation_dlq(status, enqueued_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dlq_org     ON compensation_dlq(org_id, status);
`;

export class PostgresDlqStore implements DlqStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: DlqInsert): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO compensation_dlq
       (org_id, saga_id, trace_id, tool_name, compensator_kind, last_error, attempts_made, planned_action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [r.org_id, r.saga_id ?? null, r.trace_id, r.tool_name,
       r.compensator_kind, r.last_error, r.attempts_made, r.planned_action],
    );
    return (res.rows[0] as any).id;
  }

  async get(orgId: string, id: number): Promise<DlqRow | null> {
    const r = await this.pool.query(`SELECT * FROM compensation_dlq WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (r.rows[0] as any) ?? null;
  }

  async list(opts: DlqListOpts): Promise<{ entries: DlqRow[]; total: number }> {
    const conds: string[] = ['org_id = $1'];
    const params: any[] = [opts.org_id];
    if (opts.status) { conds.push(`status = $${params.length + 1}`); params.push(opts.status); }
    const where = 'WHERE ' + conds.join(' AND ');
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM compensation_dlq ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit  = Math.min(opts.limit  ?? 50, 500);
    const offset = opts.offset ?? 0;
    const r = await this.pool.query(
      `SELECT * FROM compensation_dlq ${where} ORDER BY enqueued_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as DlqRow[], total };
  }

  async pendingCount(orgId: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM compensation_dlq WHERE org_id = $1 AND status = 'pending'`,
      [orgId],
    );
    return (r.rows[0] as any)?.n ?? 0;
  }

  async retry(orgId: string, id: number, resolvedBy: string, note?: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE compensation_dlq SET status = 'retried', resolved_at = NOW(), resolved_by = $1, resolution_note = $2
       WHERE id = $3 AND org_id = $4 AND status = 'pending'`,
      [resolvedBy, note ?? null, id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async dismiss(orgId: string, id: number, resolvedBy: string, note?: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE compensation_dlq SET status = 'dismissed', resolved_at = NOW(), resolved_by = $1, resolution_note = $2
       WHERE id = $3 AND org_id = $4 AND status = 'pending'`,
      [resolvedBy, note ?? null, id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
