/**
 * SnapshotStore — pre-action state snapshots used by the rollback /
 * saga subsystem to reverse side effects.
 *
 * One row per trace_id (the trace that captured the snapshot). The
 * snapshot_data column is the canonical serialised form; hash is its
 * SHA-256, used to detect tampering / corrupted serialisation on
 * restore. The kind column partitions snapshots by source ('git',
 * 'file', 'http-undo', etc.) so the rollback engine can dispatch to
 * the right compensator.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface SnapshotRow {
  trace_id: string;
  kind: string;
  captured_at: string;
  snapshot_data: string;
  hash: string;
}

export interface SnapshotInsert {
  trace_id: string;
  kind: string;
  snapshot_data: string;
  hash: string;
}

export interface SnapshotStore {
  init(): Promise<void>;
  insert(row: SnapshotInsert): Promise<void>;
  get(trace_id: string): Promise<SnapshotRow | null>;
  /** Bulk lookup — used by the saga engine to fetch every snapshot for
   *  a saga in one query. */
  getMany(trace_ids: string[]): Promise<SnapshotRow[]>;
  listByKind(kind: string, limit?: number): Promise<SnapshotRow[]>;
  delete(trace_id: string): Promise<boolean>;
  /** Retention: prune snapshots older than the cutoff. */
  purgeOlderThan(beforeIso: string): Promise<number>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteSnapshotStore implements SnapshotStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace_snapshot (
        trace_id      TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        captured_at   TEXT NOT NULL DEFAULT (datetime('now')),
        snapshot_data TEXT NOT NULL,
        hash          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trace_snapshot_kind ON trace_snapshot(kind);
    `);
  }

  async insert(r: SnapshotInsert): Promise<void> {
    this.db.prepare(
      `INSERT INTO trace_snapshot (trace_id, kind, snapshot_data, hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(trace_id) DO UPDATE SET
         kind = excluded.kind, snapshot_data = excluded.snapshot_data, hash = excluded.hash,
         captured_at = datetime('now')`,
    ).run(r.trace_id, r.kind, r.snapshot_data, r.hash);
  }

  async get(trace_id: string): Promise<SnapshotRow | null> {
    return (this.db.prepare(`SELECT * FROM trace_snapshot WHERE trace_id = ?`).get(trace_id) as any) ?? null;
  }

  async getMany(trace_ids: string[]): Promise<SnapshotRow[]> {
    if (trace_ids.length === 0) return [];
    const placeholders = trace_ids.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM trace_snapshot WHERE trace_id IN (${placeholders})`,
    ).all(...trace_ids) as SnapshotRow[];
  }

  async listByKind(kind: string, limit = 100): Promise<SnapshotRow[]> {
    return this.db.prepare(
      `SELECT * FROM trace_snapshot WHERE kind = ? ORDER BY captured_at DESC LIMIT ?`,
    ).all(kind, Math.min(limit, 500)) as SnapshotRow[];
  }

  async delete(trace_id: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM trace_snapshot WHERE trace_id = ?`).run(trace_id);
    return r.changes > 0;
  }

  async purgeOlderThan(beforeIso: string): Promise<number> {
    const r = this.db.prepare(`DELETE FROM trace_snapshot WHERE datetime(captured_at) < datetime(?)`).run(beforeIso);
    return r.changes;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS trace_snapshot (
    trace_id      TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    snapshot_data TEXT NOT NULL,
    hash          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trace_snapshot_kind ON trace_snapshot(kind);
`;

export class PostgresSnapshotStore implements SnapshotStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: SnapshotInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO trace_snapshot (trace_id, kind, snapshot_data, hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT(trace_id) DO UPDATE SET
         kind = EXCLUDED.kind, snapshot_data = EXCLUDED.snapshot_data, hash = EXCLUDED.hash,
         captured_at = NOW()`,
      [r.trace_id, r.kind, r.snapshot_data, r.hash],
    );
  }

  async get(trace_id: string): Promise<SnapshotRow | null> {
    const r = await this.pool.query(`SELECT * FROM trace_snapshot WHERE trace_id = $1`, [trace_id]);
    return (r.rows[0] as any) ?? null;
  }

  async getMany(trace_ids: string[]): Promise<SnapshotRow[]> {
    if (trace_ids.length === 0) return [];
    const ph = trace_ids.map((_, i) => `$${i + 1}`).join(', ');
    const r = await this.pool.query(`SELECT * FROM trace_snapshot WHERE trace_id IN (${ph})`, trace_ids);
    return r.rows as SnapshotRow[];
  }

  async listByKind(kind: string, limit = 100): Promise<SnapshotRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM trace_snapshot WHERE kind = $1 ORDER BY captured_at DESC LIMIT $2`,
      [kind, Math.min(limit, 500)],
    );
    return r.rows as SnapshotRow[];
  }

  async delete(trace_id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM trace_snapshot WHERE trace_id = $1`, [trace_id]);
    return (r.rowCount ?? 0) > 0;
  }

  async purgeOlderThan(beforeIso: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM trace_snapshot WHERE captured_at < $1`, [beforeIso]);
    return r.rowCount ?? 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
