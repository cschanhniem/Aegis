/**
 * ScanHistoryService — persists every pre-deployment scan result so
 * the Cockpit can list them, compare them, and re-emit SARIF without
 * re-running the (slow) scanner subprocess.
 *
 * Storage: one row per scan in `scan_history`. Findings + raw SARIF
 * are JSON-encoded into TEXT columns. SQLite handles the JSON via
 * its `json_extract` / `json1` operators for any future indexed
 * queries (severity counts, etc.).
 *
 * Why a dedicated table when findings already live in the Merkle
 * transparency log: the Merkle log is **append-only + signed** —
 * great for non-repudiable proof, bad for "show me my last 10 scans
 * sorted by date". scan_history is the queryable cache; Merkle stays
 * the source of truth for legal / compliance "did this happen?"
 * questions.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import {
  AegisFinding,
  FindingSeverity,
  FindingTier,
  ScanReport,
} from './predeploy-scan';

export interface ScanHistoryRow {
  id: number;
  org_id: string;
  scan_path: string;
  scanned_at: string;
  scanned_by: string | null;
  tool_name: string;
  tool_version: string | null;
  finding_count: number;
  by_severity: Partial<Record<FindingSeverity, number>>;
  by_tier: Partial<Record<FindingTier, number>>;
  /** Set only when `loadDetail()` was called — list endpoint returns
   *  the summary fields above without paying the SARIF parse cost. */
  findings?: AegisFinding[];
  sarif?: unknown;
}

export interface ListOptions {
  orgId: string;
  limit?: number;
  /** Filter to a specific repo path. */
  path?: string;
  /** Filter to scans newer than this ISO timestamp. */
  since?: string;
}

export class ScanHistoryService {
  constructor(private db: Database.Database, private logger: Logger) {
    this.ensureTable();
  }

  private ensureTable(): void {
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
      CREATE INDEX IF NOT EXISTS idx_scan_history_org_at ON scan_history(org_id, scanned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scan_history_path   ON scan_history(org_id, scan_path, scanned_at DESC);
    `);
  }

  /** Persist a successful ScanReport. Returns the new row's id so the
   *  caller can attach it to API responses (`scan_id`). */
  ingest(opts: { orgId: string; scannedBy?: string | null; report: ScanReport }): number {
    const r = opts.report;
    const stmt = this.db.prepare(
      `INSERT INTO scan_history
         (org_id, scan_path, scanned_at, scanned_by, tool_name, tool_version,
          finding_count, by_severity, by_tier, findings_json, sarif_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      opts.orgId,
      r.scan_path,
      r.scanned_at,
      opts.scannedBy ?? null,
      r.tool.name,
      r.tool.version ?? null,
      r.summary.total,
      JSON.stringify(r.summary.by_severity),
      JSON.stringify(r.summary.by_tier),
      JSON.stringify(r.findings),
      r.sarif ? JSON.stringify(r.sarif) : null,
    );
    return Number(result.lastInsertRowid);
  }

  /** List scans for the tenant. Returns lightweight rows (no findings,
   *  no SARIF). */
  list(opts: ListOptions): ScanHistoryRow[] {
    const filters: string[] = ['org_id = ?'];
    const params: any[] = [opts.orgId];
    if (opts.path) {
      filters.push('scan_path = ?');
      params.push(opts.path);
    }
    if (opts.since) {
      filters.push('scanned_at > ?');
      params.push(opts.since);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = this.db.prepare(
      `SELECT id, org_id, scan_path, scanned_at, scanned_by,
              tool_name, tool_version, finding_count, by_severity, by_tier
         FROM scan_history
        WHERE ${filters.join(' AND ')}
        ORDER BY scanned_at DESC
        LIMIT ?`,
    ).all(...params, limit) as any[];
    return rows.map(this.rowToSummary);
  }

  /** Fetch a single scan WITH findings + raw SARIF (used by detail UI
   *  + SARIF re-export). Returns null when not found / wrong tenant. */
  get(opts: { orgId: string; id: number }): ScanHistoryRow | null {
    const row = this.db.prepare(
      `SELECT id, org_id, scan_path, scanned_at, scanned_by,
              tool_name, tool_version, finding_count, by_severity, by_tier,
              findings_json, sarif_json
         FROM scan_history WHERE id = ? AND org_id = ?`,
    ).get(opts.id, opts.orgId) as any;
    if (!row) return null;
    const out = this.rowToSummary(row);
    out.findings = safeJson<AegisFinding[]>(row.findings_json) ?? [];
    out.sarif    = safeJson<unknown>(row.sarif_json) ?? undefined;
    return out;
  }

  /** Hard-delete a scan. Used by retention policies; not by the
   *  regular cockpit (deletion is destructive and there's no UI hook). */
  delete(opts: { orgId: string; id: number }): boolean {
    const r = this.db.prepare(`DELETE FROM scan_history WHERE id = ? AND org_id = ?`).run(opts.id, opts.orgId);
    return r.changes > 0;
  }

  private rowToSummary = (row: any): ScanHistoryRow => ({
    id: row.id,
    org_id: row.org_id,
    scan_path: row.scan_path,
    scanned_at: row.scanned_at,
    scanned_by: row.scanned_by,
    tool_name: row.tool_name,
    tool_version: row.tool_version,
    finding_count: row.finding_count,
    by_severity: safeJson<Partial<Record<FindingSeverity, number>>>(row.by_severity) ?? {},
    by_tier:     safeJson<Partial<Record<FindingTier, number>>>(row.by_tier) ?? {},
  });
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
