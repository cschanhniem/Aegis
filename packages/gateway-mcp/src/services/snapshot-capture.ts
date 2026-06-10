/**
 * Pre-state snapshot capture — the missing primitive that makes
 * rollback actually work for stateful tools.
 *
 * Problem: a `db_update` tool call's compensator needs the OLD column
 * values to restore them. The tool call itself only carries the NEW
 * values + the row key. Without capturing the pre-state at call time,
 * rollback for any non-trivial side-effect is impossible.
 *
 * Three capture modes, declared per-tool in tenant_config.rollback.snapshots:
 *
 *   inline_args
 *     Zero config. `pre_state := tool.arguments` verbatim. Useful for
 *     simple compensators where the args carry enough info (e.g. an
 *     INSERT compensated by DELETE WHERE id = args.id).
 *
 *   webhook
 *     Operator-owned URL invoked BEFORE the tool executes. AEGIS POSTs
 *     { tool_name, arguments } and the operator's service returns a
 *     JSON blob — typically the affected row(s) from their DB. AEGIS
 *     stores the blob alongside the trace, hashes it, and feeds it
 *     into the compensator on rollback.
 *
 *   db_row
 *     Operator declares a SQL `SELECT` template + arg-key map.
 *     AEGIS substitutes `{{trace.tool_call.arguments.<key>}}`
 *     placeholders, sends the query to a tenant-supplied data-snapshot
 *     webhook, stores the returned rows. We deliberately don't run SQL
 *     in-gateway (privileged credentials surface) — the webhook
 *     bridges the gap.
 *
 * Captured snapshots:
 *   - SHA-256 hashed → tamper-evident (the rollback receipt's signed
 *     Merkle leaf carries the snapshot hash; replay the snapshot, hash,
 *     compare → offline verification).
 *   - Stored in `trace_snapshot` row keyed by trace_id.
 *   - On rollback, RollbackService reads the snapshot and merges it
 *     into the compensator webhook body as `pre_state`.
 *
 * Performance: capture is on the hot path of the tool-call ingest, so
 * the webhook variants have hard timeouts (default 2s) and any error
 * falls back to inline_args + a warning audit row. We never block the
 * call indefinitely.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { createHash } from 'crypto';

export type CaptureKind = 'inline_args' | 'webhook' | 'db_row';

export interface CaptureInlineArgs {
  kind: 'inline_args';
}

export interface CaptureWebhook {
  kind: 'webhook';
  /** Operator-owned URL that returns the pre-state blob. */
  url: string;
  /** Optional Authorization header. */
  authorization?: string;
  /** Per-call timeout (ms). Default 2000. */
  timeout_ms?: number;
}

export interface CaptureDbRow {
  kind: 'db_row';
  /** Operator-owned snapshot bridge URL. AEGIS POSTs the rendered SQL
   *  + bind params; bridge runs the SELECT (read-only credentials) and
   *  returns the row(s). */
  url: string;
  /** SQL template — supports `{{trace.tool_call.arguments.<key>}}`
   *  placeholders. */
  sql: string;
  /** Optional Authorization header. */
  authorization?: string;
  /** Per-call timeout (ms). Default 2000. */
  timeout_ms?: number;
}

export type CaptureConfig = CaptureInlineArgs | CaptureWebhook | CaptureDbRow;

export interface SnapshotConfig {
  /** Map of tool_name → capture mode. Tools not present default to
   *  no capture (rollback proceeds without pre_state). */
  snapshots: Record<string, CaptureConfig>;
}

export interface SnapshotRow {
  trace_id: string;
  kind: CaptureKind;
  captured_at: string;
  snapshot_data: any;
  /** SHA-256 of stringify(snapshot_data) — for tamper-evidence. */
  hash: string;
}

export interface CaptureInput {
  orgId: string;
  trace_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface CaptureResult {
  ok: boolean;
  snapshot?: SnapshotRow;
  fallback?: 'inline_args';
  error?: string;
}

export class SnapshotCaptureService {
  private byTenant: Map<string, SnapshotConfig> = new Map();

  constructor(private db: Database.Database, private logger: Logger) {
    this.ensureTable();
  }

  private ensureTable(): void {
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

  /** Replace the snapshot config for a tenant (called by the
   *  ConfigBus subscriber when tenant_config.rollback.snapshots
   *  changes). */
  setConfig(orgId: string, cfg: SnapshotConfig | null): void {
    if (!cfg) {
      this.byTenant.delete(orgId);
      return;
    }
    this.byTenant.set(orgId, cfg);
  }

  lookup(orgId: string, toolName: string): CaptureConfig | null {
    return this.byTenant.get(orgId)?.snapshots?.[toolName] ?? null;
  }

  /**
   * Run capture for a tool call. Synchronous-style return so callers
   * can `await capture()` before letting the tool execute.
   *
   * Errors during webhook / db_row capture do NOT block the tool call
   * — we fall back to inline_args and log a warning. This keeps the
   * gateway from becoming a DoS vector via misconfigured snapshot
   * bridges.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const cfg = this.lookup(input.orgId, input.tool_name);
    // No config → no capture (rollback proceeds without pre_state).
    if (!cfg) {
      return { ok: true };
    }

    try {
      const snapshot = await this.runCapture(cfg, input);
      this.persist(snapshot);
      return { ok: true, snapshot };
    } catch (err: any) {
      this.logger.warn(
        { err: err.message, trace_id: input.trace_id, tool_name: input.tool_name },
        'snapshot capture failed; falling back to inline_args',
      );
      const fallback: SnapshotRow = {
        trace_id: input.trace_id,
        kind: 'inline_args',
        captured_at: new Date().toISOString(),
        snapshot_data: input.arguments,
        hash: hashOf(input.arguments),
      };
      this.persist(fallback);
      return { ok: true, snapshot: fallback, fallback: 'inline_args', error: err.message };
    }
  }

  /** Read the snapshot for a trace (used by RollbackService on
   *  rollback). Returns null when nothing was captured. */
  get(trace_id: string): SnapshotRow | null {
    const row = this.db.prepare(
      `SELECT trace_id, kind, captured_at, snapshot_data, hash
         FROM trace_snapshot WHERE trace_id = ?`,
    ).get(trace_id) as any;
    if (!row) return null;
    return {
      trace_id: row.trace_id,
      kind: row.kind as CaptureKind,
      captured_at: row.captured_at,
      snapshot_data: safeJson(row.snapshot_data) ?? row.snapshot_data,
      hash: row.hash,
    };
  }

  // ── internal ───────────────────────────────────────────────────────

  private async runCapture(cfg: CaptureConfig, input: CaptureInput): Promise<SnapshotRow> {
    if (cfg.kind === 'inline_args') {
      return {
        trace_id: input.trace_id,
        kind: 'inline_args',
        captured_at: new Date().toISOString(),
        snapshot_data: input.arguments,
        hash: hashOf(input.arguments),
      };
    }

    if (cfg.kind === 'webhook') {
      const data = await fetchJson(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.authorization ? { 'Authorization': cfg.authorization } : {}),
        },
        body: JSON.stringify({
          trace_id: input.trace_id,
          tool_name: input.tool_name,
          arguments: input.arguments,
          phase: 'pre_state_capture',
        }),
        timeout_ms: cfg.timeout_ms ?? 2000,
      });
      return {
        trace_id: input.trace_id,
        kind: 'webhook',
        captured_at: new Date().toISOString(),
        snapshot_data: data,
        hash: hashOf(data),
      };
    }

    if (cfg.kind === 'db_row') {
      const rendered = renderTemplate(cfg.sql, {
        trace: { tool_call: { arguments: input.arguments } },
      });
      const data = await fetchJson(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.authorization ? { 'Authorization': cfg.authorization } : {}),
        },
        body: JSON.stringify({
          trace_id: input.trace_id,
          tool_name: input.tool_name,
          sql: rendered,
          phase: 'pre_state_capture',
        }),
        timeout_ms: cfg.timeout_ms ?? 2000,
      });
      return {
        trace_id: input.trace_id,
        kind: 'db_row',
        captured_at: new Date().toISOString(),
        snapshot_data: data,
        hash: hashOf(data),
      };
    }
    // Unreachable — TS exhaustiveness
    throw new Error(`unknown capture kind: ${(cfg as any).kind}`);
  }

  private persist(row: SnapshotRow): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO trace_snapshot (trace_id, kind, captured_at, snapshot_data, hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.trace_id, row.kind, row.captured_at, JSON.stringify(row.snapshot_data), row.hash);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function hashOf(x: unknown): string {
  return createHash('sha256').update(canonicalJson(x)).digest('hex');
}

/** Deterministic JSON — sorted keys so identical objects always hash
 *  the same, regardless of how the upstream language ordered them. */
function canonicalJson(x: unknown): string {
  if (x === null || x === undefined) return 'null';
  if (typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(x as any).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((x as any)[k])}`).join(',')}}`;
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function renderTemplate(template: string, ctx: any): string {
  return template.replace(/\{\{\s*([\w.[\]'"]+)\s*\}\}/g, (_m, path) => {
    const v = path.split('.').reduce((cur: any, p: string) => cur?.[p], ctx);
    return v === undefined ? `{{${path}}}` : String(v);
  });
}

interface FetchJsonOpts {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeout_ms: number;
}

async function fetchJson(url: string, opts: FetchJsonOpts): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeout_ms);
  try {
    const res = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`snapshot bridge returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`snapshot capture timed out (${opts.timeout_ms}ms)`);
    throw err;
  }
}
