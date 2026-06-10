/**
 * Compensation Dead-Letter Queue.
 *
 * When a compensator webhook fails despite retries, the failed
 * attempt lands in `compensation_dlq`. Operators see it on a UI
 * page and can:
 *
 *   - **retry**     re-run the compensator (fresh attempt sequence)
 *   - **dismiss**   mark as "we've manually corrected it; stop bothering me"
 *   - **inspect**   read the planned action + the executor error
 *
 * Without the DLQ, failed rollbacks vanish into the audit log and
 * nobody notices. With it, the operator has a queryable backlog
 * that's automatically cleared as compensations succeed (on retry)
 * or are explicitly dismissed.
 *
 * DLQ entries are SCOPED to a tenant + saga + trace, so cross-tenant
 * leakage is impossible.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';

export type DlqStatus = 'pending' | 'retried' | 'dismissed';

export interface DlqRow {
  id: number;
  org_id: string;
  saga_id: string | null;
  trace_id: string;
  tool_name: string;
  compensator_kind: string;
  /** Operator-facing reason text (last execution error). */
  last_error: string;
  /** Number of attempts already made (including the failing one). */
  attempts_made: number;
  /** The planned compensator payload (so the operator can inspect
   *  what would re-fire on retry). */
  planned_action: any;
  status: DlqStatus;
  enqueued_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export class DlqService {
  constructor(private db: Database.Database, private logger: Logger) {
    this.ensureTable();
  }

  private ensureTable(): void {
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
      CREATE INDEX IF NOT EXISTS idx_dlq_org_status ON compensation_dlq(org_id, status, enqueued_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dlq_trace      ON compensation_dlq(trace_id);
    `);
  }

  /** Enqueue a failed compensation. Returns the row id. */
  enqueue(opts: {
    orgId: string;
    saga_id?: string | null;
    trace_id: string;
    tool_name: string;
    compensator_kind: string;
    last_error: string;
    attempts_made: number;
    planned_action: unknown;
  }): number {
    const r = this.db.prepare(
      `INSERT INTO compensation_dlq
         (org_id, saga_id, trace_id, tool_name, compensator_kind, last_error, attempts_made, planned_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.orgId,
      opts.saga_id ?? null,
      opts.trace_id,
      opts.tool_name,
      opts.compensator_kind,
      opts.last_error,
      opts.attempts_made,
      JSON.stringify(opts.planned_action),
    );
    return Number(r.lastInsertRowid);
  }

  list(opts: { orgId: string; status?: DlqStatus; limit?: number }): DlqRow[] {
    const filters: string[] = ['org_id = ?'];
    const params: any[] = [opts.orgId];
    if (opts.status) { filters.push('status = ?'); params.push(opts.status); }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = this.db.prepare(
      `SELECT id, org_id, saga_id, trace_id, tool_name, compensator_kind, last_error,
              attempts_made, planned_action, status, enqueued_at, resolved_at, resolved_by, resolution_note
         FROM compensation_dlq
        WHERE ${filters.join(' AND ')}
        ORDER BY enqueued_at DESC
        LIMIT ?`,
    ).all(...params, limit) as any[];
    return rows.map(this.rowToDlq);
  }

  get(opts: { orgId: string; id: number }): DlqRow | null {
    const row = this.db.prepare(
      `SELECT id, org_id, saga_id, trace_id, tool_name, compensator_kind, last_error,
              attempts_made, planned_action, status, enqueued_at, resolved_at, resolved_by, resolution_note
         FROM compensation_dlq WHERE id = ? AND org_id = ?`,
    ).get(opts.id, opts.orgId) as any;
    return row ? this.rowToDlq(row) : null;
  }

  /** Mark a DLQ entry as `retried`. Operator triggers this when they
   *  re-invoke rollback; the call is just a state update, not the
   *  retry itself — see api/rollback.ts for the retry orchestration. */
  markRetried(opts: { orgId: string; id: number; actor?: string }): boolean {
    const r = this.db.prepare(
      `UPDATE compensation_dlq SET status='retried', resolved_at=datetime('now'), resolved_by=?
         WHERE id=? AND org_id=? AND status='pending'`,
    ).run(opts.actor ?? null, opts.id, opts.orgId);
    return r.changes > 0;
  }

  /** Mark a DLQ entry as `dismissed`. Operator acknowledges the
   *  failure won't be auto-retried (they corrected manually). */
  dismiss(opts: { orgId: string; id: number; actor?: string; note?: string }): boolean {
    const r = this.db.prepare(
      `UPDATE compensation_dlq SET status='dismissed', resolved_at=datetime('now'),
                                   resolved_by=?, resolution_note=?
         WHERE id=? AND org_id=? AND status='pending'`,
    ).run(opts.actor ?? null, opts.note ?? null, opts.id, opts.orgId);
    return r.changes > 0;
  }

  /** Counts by status — useful for dashboards. */
  stats(orgId: string): Record<DlqStatus, number> {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) as n FROM compensation_dlq WHERE org_id = ? GROUP BY status`,
    ).all(orgId) as { status: DlqStatus; n: number }[];
    const out: Record<DlqStatus, number> = { pending: 0, retried: 0, dismissed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  private rowToDlq = (row: any): DlqRow => ({
    id: row.id,
    org_id: row.org_id,
    saga_id: row.saga_id,
    trace_id: row.trace_id,
    tool_name: row.tool_name,
    compensator_kind: row.compensator_kind,
    last_error: row.last_error,
    attempts_made: row.attempts_made,
    planned_action: (() => { try { return JSON.parse(row.planned_action); } catch { return row.planned_action; } })(),
    status: row.status,
    enqueued_at: row.enqueued_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
  });
}
