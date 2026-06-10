/**
 * ScanHistoryStore — persisted pre-deployment scan results.
 *
 * One row per `agentguard scan` invocation. Findings + SARIF are
 * JSON-encoded into TEXT/JSONB columns. The "list" endpoint returns
 * summary fields only; "loadDetail" pulls the full SARIF blob.
 *
 * Indices match the cockpit's two access patterns:
 *   - "show me my recent scans"             → (org_id, scanned_at DESC)
 *   - "show me scans for this repo path"    → (org_id, scan_path, scanned_at DESC)
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface ScanHistoryRow {
  id: number;
  org_id: string;
  scan_path: string;
  scanned_at: string;
  scanned_by: string | null;
  tool_name: string;
  tool_version: string | null;
  finding_count: number;
  by_severity: string;
  by_tier: string;
  findings_json: string | null;
  sarif_json: string | null;
}

export interface ScanHistoryInsert {
  org_id: string;
  scan_path: string;
  scanned_at: string;
  scanned_by?: string | null;
  tool_name: string;
  tool_version?: string | null;
  finding_count: number;
  by_severity: string;
  by_tier: string;
  findings_json?: string | null;
  sarif_json?: string | null;
}

export interface ScanHistoryListOpts {
  org_id: string;
  path?: string;
  since?: string;
  limit?: number;
}

export interface ScanHistoryStore {
  init(): Promise<void>;
  insert(row: ScanHistoryInsert): Promise<number>;
  /** Summary list — does NOT include findings_json / sarif_json. */
  list(opts: ScanHistoryListOpts): Promise<ScanHistoryRow[]>;
  /** Detail fetch — full row including findings + SARIF. */
  get(orgId: string, id: number): Promise<ScanHistoryRow | null>;
  /** Retention: delete rows older than the cutoff. */
  purgeOlderThan(orgId: string, beforeIso: string): Promise<number>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteScanHistoryStore implements ScanHistoryStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id        TEXT NOT NULL,
        scan_path     TEXT NOT NULL,
        scanned_at    TEXT NOT NULL,
        scanned_by    TEXT,
        tool_name     TEXT NOT NULL,
        tool_version  TEXT,
        finding_count INTEGER NOT NULL DEFAULT 0,
        by_severity   TEXT NOT NULL DEFAULT '{}',
        by_tier       TEXT NOT NULL DEFAULT '{}',
        findings_json TEXT,
        sarif_json    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scan_history_org      ON scan_history(org_id, scanned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scan_history_org_path ON scan_history(org_id, scan_path, scanned_at DESC);
    `);
  }

  async insert(r: ScanHistoryInsert): Promise<number> {
    const info = this.db.prepare(
      `INSERT INTO scan_history
        (org_id, scan_path, scanned_at, scanned_by, tool_name, tool_version,
         finding_count, by_severity, by_tier, findings_json, sarif_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.org_id, r.scan_path, r.scanned_at, r.scanned_by ?? null,
      r.tool_name, r.tool_version ?? null,
      r.finding_count, r.by_severity, r.by_tier,
      r.findings_json ?? null, r.sarif_json ?? null,
    );
    return info.lastInsertRowid as number;
  }

  async list(opts: ScanHistoryListOpts): Promise<ScanHistoryRow[]> {
    const conds: string[] = ['org_id = ?'];
    const params: any[] = [opts.org_id];
    if (opts.path)  { conds.push('scan_path = ?');  params.push(opts.path); }
    if (opts.since) { conds.push('scanned_at >= ?'); params.push(opts.since); }
    const limit = Math.min(opts.limit ?? 50, 500);
    return this.db.prepare(
      `SELECT id, org_id, scan_path, scanned_at, scanned_by, tool_name, tool_version,
              finding_count, by_severity, by_tier, NULL as findings_json, NULL as sarif_json
       FROM scan_history WHERE ${conds.join(' AND ')}
       ORDER BY scanned_at DESC LIMIT ?`,
    ).all(...params, limit) as ScanHistoryRow[];
  }

  async get(orgId: string, id: number): Promise<ScanHistoryRow | null> {
    return (this.db.prepare(`SELECT * FROM scan_history WHERE id = ? AND org_id = ?`).get(id, orgId) as any) ?? null;
  }

  async purgeOlderThan(orgId: string, beforeIso: string): Promise<number> {
    const r = this.db.prepare(`DELETE FROM scan_history WHERE org_id = ? AND scanned_at < ?`).run(orgId, beforeIso);
    return r.changes;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scan_history (
    id BIGSERIAL PRIMARY KEY,
    org_id        TEXT NOT NULL,
    scan_path     TEXT NOT NULL,
    scanned_at    TEXT NOT NULL,
    scanned_by    TEXT,
    tool_name     TEXT NOT NULL,
    tool_version  TEXT,
    finding_count INTEGER NOT NULL DEFAULT 0,
    by_severity   TEXT NOT NULL DEFAULT '{}',
    by_tier       TEXT NOT NULL DEFAULT '{}',
    findings_json TEXT,
    sarif_json    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scan_history_org      ON scan_history(org_id, scanned_at DESC);
  CREATE INDEX IF NOT EXISTS idx_scan_history_org_path ON scan_history(org_id, scan_path, scanned_at DESC);
`;

export class PostgresScanHistoryStore implements ScanHistoryStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(r: ScanHistoryInsert): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO scan_history
        (org_id, scan_path, scanned_at, scanned_by, tool_name, tool_version,
         finding_count, by_severity, by_tier, findings_json, sarif_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [r.org_id, r.scan_path, r.scanned_at, r.scanned_by ?? null,
       r.tool_name, r.tool_version ?? null,
       r.finding_count, r.by_severity, r.by_tier,
       r.findings_json ?? null, r.sarif_json ?? null],
    );
    return (res.rows[0] as any).id;
  }

  async list(opts: ScanHistoryListOpts): Promise<ScanHistoryRow[]> {
    const conds: string[] = ['org_id = $1'];
    const params: any[] = [opts.org_id];
    if (opts.path)  { conds.push(`scan_path = $${params.length + 1}`);  params.push(opts.path); }
    if (opts.since) { conds.push(`scanned_at >= $${params.length + 1}`); params.push(opts.since); }
    const limit = Math.min(opts.limit ?? 50, 500);
    const r = await this.pool.query(
      `SELECT id, org_id, scan_path, scanned_at, scanned_by, tool_name, tool_version,
              finding_count, by_severity, by_tier, NULL as findings_json, NULL as sarif_json
       FROM scan_history WHERE ${conds.join(' AND ')}
       ORDER BY scanned_at DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return r.rows as ScanHistoryRow[];
  }

  async get(orgId: string, id: number): Promise<ScanHistoryRow | null> {
    const r = await this.pool.query(`SELECT * FROM scan_history WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (r.rows[0] as any) ?? null;
  }

  async purgeOlderThan(orgId: string, beforeIso: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM scan_history WHERE org_id = $1 AND scanned_at < $2`, [orgId, beforeIso]);
    return r.rowCount ?? 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
