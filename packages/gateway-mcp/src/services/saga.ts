/**
 * Saga state machine + step ledger.
 *
 * Industrial-grade rollback needs a queryable, formal saga state.
 * Without it operators can't answer "what's in flight right now?"
 * "where did the last chain stop?" "is anything stuck?"
 *
 * State machine (Garcia-Molina 1987, adapted for agent rollback):
 *
 *   STARTED → EXECUTING → COMPENSATING → { COMPLETED | ABORTED | FAILED }
 *                                            ↑
 *   Transition rules:                        |
 *     STARTED       → EXECUTING                 (open the saga; first step starts)
 *     EXECUTING     → COMPENSATING               (one of the steps failed)
 *     EXECUTING     → COMPLETED                  (all steps succeeded; saga done)
 *     COMPENSATING  → ABORTED                    (compensation finished; saga rolled back cleanly)
 *     COMPENSATING  → FAILED                     (compensation itself failed somewhere)
 *
 * Invariants enforced by transition():
 *   - Cannot go backward.
 *   - Terminal states (COMPLETED / ABORTED / FAILED) are write-locked.
 *   - Every transition writes a row to `saga_step` so the full
 *     lifecycle is auditable post-hoc.
 *
 * This module is the SCAFFOLDING for the RollbackService — the
 * service constructs a saga at the start of every rollback() /
 * rollbackChain() call and transitions it as work proceeds.
 *
 * Notable: rolling back a SINGLE trace also opens a saga (a degenerate
 * one with one step). Keeps the audit-log queries uniform.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { randomUUID } from 'crypto';

export type SagaState =
  | 'STARTED'
  | 'EXECUTING'
  | 'COMPENSATING'
  | 'COMPLETED'
  | 'ABORTED'
  | 'FAILED';

export type SagaKind = 'rollback_single' | 'rollback_chain';

export type StepOutcome = 'rolled_back' | 'no_op' | 'failed' | 'unsupported' | 'skipped';

export interface Saga {
  id: string;
  org_id: string;
  kind: SagaKind;
  state: SagaState;
  agent_id: string | null;
  /** The "anchor" trace — for single, the one being rolled back; for
   *  chain, the most-recent trace in the time range. */
  root_trace_id: string | null;
  started_at: string;
  completed_at: string | null;
  step_count: number;
  /** Operator-supplied reason carried through every audit row. */
  reason: string | null;
}

export interface SagaStep {
  id: number;
  saga_id: string;
  step_idx: number;
  trace_id: string;
  outcome: StepOutcome;
  compensator_kind: string;
  duration_ms: number;
  error: string | null;
  recorded_at: string;
}

const VALID_TRANSITIONS: Record<SagaState, SagaState[]> = {
  STARTED:      ['EXECUTING'],
  EXECUTING:    ['COMPENSATING', 'COMPLETED'],
  COMPENSATING: ['ABORTED', 'FAILED'],
  COMPLETED:    [],
  ABORTED:      [],
  FAILED:       [],
};

export class SagaService {
  constructor(private db: Database.Database, private logger: Logger) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS saga (
        id            TEXT PRIMARY KEY,
        org_id        TEXT NOT NULL,
        kind          TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'STARTED',
        agent_id      TEXT,
        root_trace_id TEXT,
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT,
        step_count    INTEGER NOT NULL DEFAULT 0,
        reason        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_saga_org_state ON saga(org_id, state);
      CREATE INDEX IF NOT EXISTS idx_saga_agent     ON saga(agent_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS saga_step (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        saga_id         TEXT NOT NULL,
        step_idx        INTEGER NOT NULL,
        trace_id        TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        compensator_kind TEXT NOT NULL,
        duration_ms     INTEGER NOT NULL,
        error           TEXT,
        recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_saga_step_saga ON saga_step(saga_id, step_idx);
    `);
  }

  /** Open a new saga. Returns the id; the caller passes it to
   *  appendStep() + transition() as work progresses. */
  open(opts: {
    orgId: string;
    kind: SagaKind;
    agent_id?: string | null;
    root_trace_id?: string | null;
    reason?: string | null;
  }): string {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO saga (id, org_id, kind, state, agent_id, root_trace_id, reason)
       VALUES (?, ?, ?, 'STARTED', ?, ?, ?)`,
    ).run(
      id, opts.orgId, opts.kind,
      opts.agent_id ?? null,
      opts.root_trace_id ?? null,
      opts.reason ?? null,
    );
    return id;
  }

  /** Transition a saga to a new state. Throws on invalid transitions
   *  — RollbackService catches and audits these as bugs. */
  transition(opts: { sagaId: string; orgId: string; to: SagaState }): void {
    const row = this.db.prepare(
      `SELECT state FROM saga WHERE id = ? AND org_id = ?`,
    ).get(opts.sagaId, opts.orgId) as { state: SagaState } | undefined;
    if (!row) throw new Error(`saga ${opts.sagaId} not found`);
    if (row.state === opts.to) return;  // idempotent

    const allowed = VALID_TRANSITIONS[row.state];
    if (!allowed.includes(opts.to)) {
      throw new Error(`invalid saga transition: ${row.state} → ${opts.to}`);
    }
    const isTerminal = ['COMPLETED', 'ABORTED', 'FAILED'].includes(opts.to);
    if (isTerminal) {
      this.db.prepare(
        `UPDATE saga SET state = ?, completed_at = datetime('now') WHERE id = ?`,
      ).run(opts.to, opts.sagaId);
    } else {
      this.db.prepare(`UPDATE saga SET state = ? WHERE id = ?`).run(opts.to, opts.sagaId);
    }
  }

  /** Append a step to the saga. Returns the new step id. */
  appendStep(opts: {
    sagaId: string;
    trace_id: string;
    outcome: StepOutcome;
    compensator_kind: string;
    duration_ms: number;
    error?: string | null;
  }): number {
    const sequence = this.db.prepare(
      `SELECT step_count FROM saga WHERE id = ?`,
    ).get(opts.sagaId) as { step_count: number } | undefined;
    const nextIdx = (sequence?.step_count ?? 0) + 1;

    const r = this.db.prepare(
      `INSERT INTO saga_step (saga_id, step_idx, trace_id, outcome, compensator_kind, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.sagaId, nextIdx, opts.trace_id, opts.outcome,
      opts.compensator_kind, opts.duration_ms, opts.error ?? null,
    );

    this.db.prepare(
      `UPDATE saga SET step_count = step_count + 1 WHERE id = ?`,
    ).run(opts.sagaId);
    return Number(r.lastInsertRowid);
  }

  /** Fetch the saga record. */
  get(opts: { sagaId: string; orgId: string }): Saga | null {
    const row = this.db.prepare(
      `SELECT id, org_id, kind, state, agent_id, root_trace_id, started_at, completed_at, step_count, reason
         FROM saga WHERE id = ? AND org_id = ?`,
    ).get(opts.sagaId, opts.orgId) as any;
    return row ?? null;
  }

  /** Fetch all steps for a saga in step_idx order. */
  steps(opts: { sagaId: string; orgId: string }): SagaStep[] {
    // Scope check: only return steps if the saga itself is in the org
    if (!this.get(opts)) return [];
    return this.db.prepare(
      `SELECT id, saga_id, step_idx, trace_id, outcome, compensator_kind, duration_ms, error, recorded_at
         FROM saga_step WHERE saga_id = ? ORDER BY step_idx ASC`,
    ).all(opts.sagaId) as SagaStep[];
  }

  /** List sagas for a tenant. Supports filtering by state. */
  list(opts: {
    orgId: string;
    state?: SagaState | SagaState[];
    agent_id?: string;
    limit?: number;
  }): Saga[] {
    const filters: string[] = ['org_id = ?'];
    const params: any[] = [opts.orgId];
    if (opts.state) {
      const states = Array.isArray(opts.state) ? opts.state : [opts.state];
      filters.push(`state IN (${states.map(() => '?').join(',')})`);
      params.push(...states);
    }
    if (opts.agent_id) {
      filters.push('agent_id = ?');
      params.push(opts.agent_id);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    return this.db.prepare(
      `SELECT id, org_id, kind, state, agent_id, root_trace_id, started_at, completed_at, step_count, reason
         FROM saga
        WHERE ${filters.join(' AND ')}
        ORDER BY started_at DESC
        LIMIT ?`,
    ).all(...params, limit) as Saga[];
  }
}
