/**
 * SagaStore — distributed-transaction execution state.
 *
 * Two tables: `saga` (one row per execution) + `saga_step` (one per
 * step inside a saga). The store implements the state machine the
 * Saga service uses: STARTED → COMPLETED / COMPENSATING / COMPENSATED.
 *
 * Per-org isolation on the saga table; saga_step rows inherit org
 * scope through the saga_id foreign key.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export type SagaState = 'STARTED' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED' | 'FAILED';

export interface SagaRow {
  id: string;
  org_id: string;
  kind: string;
  state: SagaState;
  agent_id: string | null;
  root_trace_id: string | null;
  started_at: string;
  completed_at: string | null;
  step_count: number;
  reason: string | null;
}

export interface SagaStepRow {
  id: number;
  saga_id: string;
  step_idx: number;
  trace_id: string;
  outcome: string;
  compensator_kind: string;
  duration_ms: number;
  error: string | null;
  recorded_at: string;
}

export interface SagaInsert {
  id: string;
  org_id: string;
  kind: string;
  agent_id?: string | null;
  root_trace_id?: string | null;
}

export interface SagaStepInsert {
  saga_id: string;
  step_idx: number;
  trace_id: string;
  outcome: string;
  compensator_kind: string;
  duration_ms: number;
  error?: string | null;
}

export interface SagaListOpts {
  org_id: string;
  state?: SagaState | SagaState[];
  agent_id?: string;
  limit?: number;
}

export interface SagaStore {
  init(): Promise<void>;
  open(row: SagaInsert): Promise<void>;
  get(orgId: string, id: string): Promise<SagaRow | null>;
  list(opts: SagaListOpts): Promise<SagaRow[]>;
  transition(orgId: string, id: string, state: SagaState, reason?: string): Promise<boolean>;
  appendStep(step: SagaStepInsert): Promise<void>;
  listSteps(sagaId: string): Promise<SagaStepRow[]>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteSagaStore implements SagaStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
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

  async open(r: SagaInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO saga (id, org_id, kind, agent_id, root_trace_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(r.id, r.org_id, r.kind, r.agent_id ?? null, r.root_trace_id ?? null);
  }

  async get(orgId: string, id: string): Promise<SagaRow | null> {
    return (this.db.prepare(`SELECT * FROM saga WHERE id = ? AND org_id = ?`).get(id, orgId) as any) ?? null;
  }

  async list(opts: SagaListOpts): Promise<SagaRow[]> {
    const conds: string[] = ['org_id = ?'];
    const params: any[] = [opts.org_id];
    if (opts.state) {
      if (Array.isArray(opts.state)) {
        const placeholders = opts.state.map(() => '?').join(', ');
        conds.push(`state IN (${placeholders})`);
        params.push(...opts.state);
      } else {
        conds.push('state = ?'); params.push(opts.state);
      }
    }
    if (opts.agent_id) { conds.push('agent_id = ?'); params.push(opts.agent_id); }
    const limit = Math.min(opts.limit ?? 50, 500);
    return this.db.prepare(
      `SELECT * FROM saga WHERE ${conds.join(' AND ')} ORDER BY started_at DESC LIMIT ?`,
    ).all(...params, limit) as SagaRow[];
  }

  async transition(orgId: string, id: string, state: SagaState, reason?: string): Promise<boolean> {
    const completing = state === 'COMPLETED' || state === 'COMPENSATED' || state === 'FAILED';
    const r = this.db.prepare(
      `UPDATE saga SET state = ?, reason = ?, completed_at = ${completing ? `datetime('now')` : 'completed_at'} WHERE id = ? AND org_id = ?`,
    ).run(state, reason ?? null, id, orgId);
    return r.changes > 0;
  }

  async appendStep(step: SagaStepInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO saga_step (saga_id, step_idx, trace_id, outcome, compensator_kind, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(step.saga_id, step.step_idx, step.trace_id, step.outcome, step.compensator_kind, step.duration_ms, step.error ?? null);
    this.db.prepare(`UPDATE saga SET step_count = step_count + 1 WHERE id = ?`).run(step.saga_id);
  }

  async listSteps(sagaId: string): Promise<SagaStepRow[]> {
    return this.db.prepare(
      `SELECT * FROM saga_step WHERE saga_id = ? ORDER BY step_idx ASC`,
    ).all(sagaId) as SagaStepRow[];
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS saga (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL,
    kind          TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'STARTED',
    agent_id      TEXT,
    root_trace_id TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    step_count    INTEGER NOT NULL DEFAULT 0,
    reason        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_saga_org_state ON saga(org_id, state);
  CREATE INDEX IF NOT EXISTS idx_saga_agent     ON saga(agent_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS saga_step (
    id BIGSERIAL PRIMARY KEY,
    saga_id         TEXT NOT NULL,
    step_idx        INTEGER NOT NULL,
    trace_id        TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    compensator_kind TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    error           TEXT,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_saga_step_saga ON saga_step(saga_id, step_idx);
`;

export class PostgresSagaStore implements SagaStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async open(r: SagaInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO saga (id, org_id, kind, agent_id, root_trace_id) VALUES ($1, $2, $3, $4, $5)`,
      [r.id, r.org_id, r.kind, r.agent_id ?? null, r.root_trace_id ?? null],
    );
  }

  async get(orgId: string, id: string): Promise<SagaRow | null> {
    const r = await this.pool.query(`SELECT * FROM saga WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (r.rows[0] as any) ?? null;
  }

  async list(opts: SagaListOpts): Promise<SagaRow[]> {
    const conds: string[] = ['org_id = $1'];
    const params: any[] = [opts.org_id];
    if (opts.state) {
      if (Array.isArray(opts.state)) {
        const ph = opts.state.map((_, i) => `$${params.length + i + 1}`).join(', ');
        conds.push(`state IN (${ph})`);
        params.push(...opts.state);
      } else {
        conds.push(`state = $${params.length + 1}`); params.push(opts.state);
      }
    }
    if (opts.agent_id) { conds.push(`agent_id = $${params.length + 1}`); params.push(opts.agent_id); }
    const limit = Math.min(opts.limit ?? 50, 500);
    const r = await this.pool.query(
      `SELECT * FROM saga WHERE ${conds.join(' AND ')} ORDER BY started_at DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return r.rows as SagaRow[];
  }

  async transition(orgId: string, id: string, state: SagaState, reason?: string): Promise<boolean> {
    const completing = state === 'COMPLETED' || state === 'COMPENSATED' || state === 'FAILED';
    const r = await this.pool.query(
      `UPDATE saga SET state = $1, reason = $2, completed_at = ${completing ? 'NOW()' : 'completed_at'} WHERE id = $3 AND org_id = $4`,
      [state, reason ?? null, id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async appendStep(step: SagaStepInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO saga_step (saga_id, step_idx, trace_id, outcome, compensator_kind, duration_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [step.saga_id, step.step_idx, step.trace_id, step.outcome, step.compensator_kind, step.duration_ms, step.error ?? null],
    );
    await this.pool.query(`UPDATE saga SET step_count = step_count + 1 WHERE id = $1`, [step.saga_id]);
  }

  async listSteps(sagaId: string): Promise<SagaStepRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM saga_step WHERE saga_id = $1 ORDER BY step_idx ASC`,
      [sagaId],
    );
    return r.rows as SagaStepRow[];
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
