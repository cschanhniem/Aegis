/**
 * SlaMetricsStore — per-period rolled-up SLA aggregates.
 *
 * One row per (org_id, period, endpoint). The metrics service buffers
 * latency samples in-memory, flushes every interval, and merges into
 * the corresponding row (incrementing counters + replacing percentile
 * snapshots). Reads serve the cockpit "uptime / p95" tile.
 *
 * UNIQUE constraint on (org_id, period, endpoint) gates the merge:
 * the first flush in a period inserts, subsequent flushes UPSERT.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface SlaMetricRow {
  org_id: string | null;
  period: string;       // 'YYYY-MM-DDTHH:MM' bucket
  endpoint: string;
  request_count: number;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  avg_ms: number;
  updated_at: string;
}

export interface SlaMetricMerge {
  org_id: string | null;
  period: string;
  endpoint: string;
  request_count: number;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  avg_ms: number;
}

export interface SlaMetricsQueryOpts {
  org_id?: string;
  endpoint?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SlaMetricsStore {
  init(): Promise<void>;
  /** Merge an aggregate row into the table. INCREMENTs counters,
   *  REPLACES percentile snapshots (the in-memory buffer recomputes
   *  them per flush interval — last-write-wins). */
  merge(row: SlaMetricMerge): Promise<void>;
  query(opts: SlaMetricsQueryOpts): Promise<SlaMetricRow[]>;
  /** Aggregate uptime + average latency across a window. */
  summary(orgId: string | undefined, hours: number): Promise<{
    total_requests: number; total_errors: number; uptime_pct: number;
    p50: number; p95: number; p99: number; avg: number;
  }>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteSlaMetricsStore implements SlaMetricsStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sla_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT,
        period TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        request_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        p50_ms REAL DEFAULT 0,
        p95_ms REAL DEFAULT 0,
        p99_ms REAL DEFAULT 0,
        avg_ms REAL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(org_id, period, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_sla_period ON sla_metrics(period);
      CREATE INDEX IF NOT EXISTS idx_sla_org    ON sla_metrics(org_id, period);
    `);
  }

  async merge(r: SlaMetricMerge): Promise<void> {
    this.db.prepare(`
      INSERT INTO sla_metrics (org_id, period, endpoint, request_count, error_count, p50_ms, p95_ms, p99_ms, avg_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, period, endpoint)
      DO UPDATE SET
        request_count = request_count + excluded.request_count,
        error_count = error_count + excluded.error_count,
        p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms,
        p99_ms = excluded.p99_ms, avg_ms = excluded.avg_ms,
        updated_at = datetime('now')
    `).run(r.org_id, r.period, r.endpoint, r.request_count, r.error_count, r.p50_ms, r.p95_ms, r.p99_ms, r.avg_ms);
  }

  async query(opts: SlaMetricsQueryOpts): Promise<SlaMetricRow[]> {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    if (opts.org_id)   { conds.push('org_id = ?');   params.push(opts.org_id); }
    if (opts.endpoint) { conds.push('endpoint = ?'); params.push(opts.endpoint); }
    if (opts.from)     { conds.push('period >= ?');  params.push(opts.from); }
    if (opts.to)       { conds.push('period <= ?');  params.push(opts.to); }
    const where = 'WHERE ' + conds.join(' AND ');
    const limit = Math.min(opts.limit ?? 100, 1000);
    return this.db.prepare(
      `SELECT * FROM sla_metrics ${where} ORDER BY period DESC LIMIT ?`,
    ).all(...params, limit) as SlaMetricRow[];
  }

  async summary(orgId: string | undefined, hours: number): Promise<any> {
    const from = new Date(Date.now() - hours * 3600_000).toISOString().substring(0, 16);
    const conds: string[] = ['period >= ?'];
    const params: any[] = [from];
    if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
    const row = this.db.prepare(
      `SELECT
         COALESCE(SUM(request_count), 0) AS total_requests,
         COALESCE(SUM(error_count), 0)   AS total_errors,
         COALESCE(AVG(p50_ms), 0)        AS p50,
         COALESCE(AVG(p95_ms), 0)        AS p95,
         COALESCE(AVG(p99_ms), 0)        AS p99,
         COALESCE(AVG(avg_ms), 0)        AS avg_latency
       FROM sla_metrics WHERE ${conds.join(' AND ')}`,
    ).get(...params) as any;
    const total = row?.total_requests ?? 0;
    const errors = row?.total_errors ?? 0;
    const uptime = total > 0 ? Math.round(((total - errors) / total) * 10000) / 100 : 100;
    return {
      total_requests: total, total_errors: errors, uptime_pct: uptime,
      p50: Math.round(row?.p50 ?? 0), p95: Math.round(row?.p95 ?? 0),
      p99: Math.round(row?.p99 ?? 0), avg: Math.round(row?.avg_latency ?? 0),
    };
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sla_metrics (
    id BIGSERIAL PRIMARY KEY,
    org_id TEXT,
    period TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    p50_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    p95_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    p99_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, period, endpoint)
  );
  CREATE INDEX IF NOT EXISTS idx_sla_period ON sla_metrics(period);
  CREATE INDEX IF NOT EXISTS idx_sla_org    ON sla_metrics(org_id, period);
`;

export class PostgresSlaMetricsStore implements SlaMetricsStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async merge(r: SlaMetricMerge): Promise<void> {
    // pg-mem chokes on a NULL in a UNIQUE constraint key with ON
    // CONFLICT clause when org_id is null (postgres treats NULLs as
    // distinct in unique constraints). Real Postgres has the same
    // semantics, so the upstream caller MUST pass a non-null org_id
    // (use the platform-org sentinel '*' if needed).
    await this.pool.query(
      `INSERT INTO sla_metrics (org_id, period, endpoint, request_count, error_count, p50_ms, p95_ms, p99_ms, avg_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (org_id, period, endpoint)
       DO UPDATE SET
         request_count = sla_metrics.request_count + EXCLUDED.request_count,
         error_count   = sla_metrics.error_count + EXCLUDED.error_count,
         p50_ms = EXCLUDED.p50_ms, p95_ms = EXCLUDED.p95_ms,
         p99_ms = EXCLUDED.p99_ms, avg_ms = EXCLUDED.avg_ms,
         updated_at = NOW()`,
      [r.org_id, r.period, r.endpoint, r.request_count, r.error_count, r.p50_ms, r.p95_ms, r.p99_ms, r.avg_ms],
    );
  }

  async query(opts: SlaMetricsQueryOpts): Promise<SlaMetricRow[]> {
    const conds: string[] = ['1=1'];
    const params: any[] = [];
    const next = () => `$${params.length + 1}`;
    if (opts.org_id)   { conds.push(`org_id = ${next()}`);   params.push(opts.org_id); }
    if (opts.endpoint) { conds.push(`endpoint = ${next()}`); params.push(opts.endpoint); }
    if (opts.from)     { conds.push(`period >= ${next()}`);  params.push(opts.from); }
    if (opts.to)       { conds.push(`period <= ${next()}`);  params.push(opts.to); }
    const where = 'WHERE ' + conds.join(' AND ');
    const limit = Math.min(opts.limit ?? 100, 1000);
    const r = await this.pool.query(
      `SELECT * FROM sla_metrics ${where} ORDER BY period DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return r.rows as SlaMetricRow[];
  }

  async summary(orgId: string | undefined, hours: number): Promise<any> {
    const from = new Date(Date.now() - hours * 3600_000).toISOString().substring(0, 16);
    const conds: string[] = ['period >= $1'];
    const params: any[] = [from];
    if (orgId) { conds.push('org_id = $2'); params.push(orgId); }
    const r = await this.pool.query(
      `SELECT
         COALESCE(SUM(request_count), 0)::int AS total_requests,
         COALESCE(SUM(error_count), 0)::int   AS total_errors,
         COALESCE(AVG(p50_ms), 0)::double precision     AS p50,
         COALESCE(AVG(p95_ms), 0)::double precision     AS p95,
         COALESCE(AVG(p99_ms), 0)::double precision     AS p99,
         COALESCE(AVG(avg_ms), 0)::double precision     AS avg_latency
       FROM sla_metrics WHERE ${conds.join(' AND ')}`,
      params,
    );
    const row = r.rows[0] as any;
    const total = row?.total_requests ?? 0;
    const errors = row?.total_errors ?? 0;
    const uptime = total > 0 ? Math.round(((total - errors) / total) * 10000) / 100 : 100;
    return {
      total_requests: total, total_errors: errors, uptime_pct: uptime,
      p50: Math.round(row?.p50 ?? 0), p95: Math.round(row?.p95 ?? 0),
      p99: Math.round(row?.p99 ?? 0), avg: Math.round(row?.avg_latency ?? 0),
    };
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
