/**
 * TransparencyLogStore — append-only Merkle-anchored leaves.
 *
 * This is the source of truth for tamper-evident audit (RFC 6962
 * compliant). Every leaf carries:
 *   - leaf_hash  SHA-256 of the canonical payload prefixed with the
 *                RFC 6962 leaf domain-separation byte (0x00)
 *   - payload    canonical serialised event body (small TEXT — large
 *                blobs live in `traces` and are referenced by ID)
 *   - source     'audit' | 'trace' | 'witness-cosign' | ...
 *   - org_id     tenant boundary (NULL for platform-level entries)
 *
 * Strictly NO update / delete API — the chain is immutable by design.
 * The witness service (services/witness.ts) signs Merkle roots over
 * these leaves; mutating any leaf invalidates every subsequent root,
 * which is exactly the property we want to surface to auditors.
 *
 * Batched-write on Postgres because the per-trace write fanout is
 * high (one trace → one transparency leaf).
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface TransparencyLeafRow {
  id: number;
  leaf_hash: string;
  payload: string;
  source: string;
  org_id: string | null;
  created_at: string;
}

export interface TransparencyLeafInsert {
  leaf_hash: string;
  payload: string;
  source: string;
  org_id?: string | null;
}

export interface TransparencyLogStore {
  init(): Promise<void>;
  /** Append. Sync on Sqlite; batched on Postgres. Returns the assigned
   *  leaf index when sync; on async path the returned promise resolves
   *  after the buffer flush. Use `flush()` to force visibility. */
  append(row: TransparencyLeafInsert): void;
  /** Count of leaves in the log. Used to compute Merkle tree size. */
  size(): Promise<number>;
  /** Fetch a slice by 1-based leaf index (RFC 6962 convention). */
  range(start: number, end: number): Promise<TransparencyLeafRow[]>;
  /** Find by hash — used by witness verification. */
  findByHash(leafHash: string): Promise<TransparencyLeafRow | null>;
  /** Force pending writes to flush. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteTransparencyLogStore implements TransparencyLogStore {
  private insertStmt: Database.Statement | null = null;

  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transparency_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leaf_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        source TEXT NOT NULL,
        org_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tlog_hash   ON transparency_log(leaf_hash);
      CREATE INDEX IF NOT EXISTS idx_tlog_source ON transparency_log(source);
      CREATE INDEX IF NOT EXISTS idx_tlog_org    ON transparency_log(org_id, id);
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO transparency_log (leaf_hash, payload, source, org_id) VALUES (?, ?, ?, ?)`,
    );
  }

  append(r: TransparencyLeafInsert): void {
    if (!this.insertStmt) throw new Error('TransparencyLogStore: init() must be called before append()');
    this.insertStmt.run(r.leaf_hash, r.payload, r.source, r.org_id ?? null);
  }

  async size(): Promise<number> {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM transparency_log`).get() as any).n;
  }

  async range(start: number, end: number): Promise<TransparencyLeafRow[]> {
    // 1-based inclusive — RFC 6962 convention.
    return this.db.prepare(
      `SELECT * FROM transparency_log WHERE id BETWEEN ? AND ? ORDER BY id ASC`,
    ).all(start, end) as TransparencyLeafRow[];
  }

  async findByHash(leafHash: string): Promise<TransparencyLeafRow | null> {
    return (this.db.prepare(`SELECT * FROM transparency_log WHERE leaf_hash = ? LIMIT 1`).get(leafHash) as any) ?? null;
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS transparency_log (
    id BIGSERIAL PRIMARY KEY,
    leaf_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    source TEXT NOT NULL,
    org_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tlog_hash   ON transparency_log(leaf_hash);
  CREATE INDEX IF NOT EXISTS idx_tlog_source ON transparency_log(source);
  CREATE INDEX IF NOT EXISTS idx_tlog_org    ON transparency_log(org_id, id);
`;

export class PostgresTransparencyLogStore implements TransparencyLogStore {
  private pool: Pool;
  private buffer: TransparencyLeafInsert[] = [];
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

  append(r: TransparencyLeafInsert): void {
    this.buffer.push(r);
    if (this.buffer.length >= this.maxBatch) this.flush().catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    this.flushing = (async () => {
      try {
        const values: any[] = [];
        const groups: string[] = [];
        for (const r of batch) {
          const base = values.length;
          values.push(r.leaf_hash, r.payload, r.source, r.org_id ?? null);
          groups.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        }
        await this.pool.query(
          `INSERT INTO transparency_log (leaf_hash, payload, source, org_id) VALUES ${groups.join(', ')}`,
          values,
        );
      } finally { this.flushing = null; }
    })();
    return this.flushing;
  }

  async size(): Promise<number> {
    await this.flush();
    const r = await this.pool.query(`SELECT COUNT(*)::int AS n FROM transparency_log`);
    return (r.rows[0] as any).n;
  }

  async range(start: number, end: number): Promise<TransparencyLeafRow[]> {
    await this.flush();
    const r = await this.pool.query(
      `SELECT * FROM transparency_log WHERE id BETWEEN $1 AND $2 ORDER BY id ASC`,
      [start, end],
    );
    return r.rows as TransparencyLeafRow[];
  }

  async findByHash(leafHash: string): Promise<TransparencyLeafRow | null> {
    await this.flush();
    const r = await this.pool.query(
      `SELECT * FROM transparency_log WHERE leaf_hash = $1 LIMIT 1`,
      [leafHash],
    );
    return (r.rows[0] as any) ?? null;
  }

  async close(): Promise<void> {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    await this.flush().catch(() => {});
    await this.pool.end().catch(() => {});
  }
}
