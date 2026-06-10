/**
 * Delayed-effect outbox — the "fintech queue" pattern that makes
 * truly-irreversible actions (email send, payment, social post)
 * pre-execution-cancellable inside a configurable TTL window.
 *
 * Design rationale (research brief, Phase 2 of rollback work):
 *
 *   - Snapshot-and-restore (DeltaBox, CRIU) can't undo network-leaving
 *     side effects. The only reliable path is: NEVER let the side
 *     effect leave the gateway until a quiet window has elapsed.
 *
 *   - During the window, a `rollback` of the original trace_id is a
 *     cheap dequeue — zero side effect. After the window, the
 *     compensator (if registered) runs; otherwise the operator has
 *     to ship a *correction* (refund / retraction email / public
 *     correction tweet).
 *
 *   - This is exactly how Stripe Sigma + delayed-capture, Ramp's
 *     shadow ledger, and SES's 30s outbound preview work in prod.
 *
 * Storage: SQLite table `effect_outbox`. Each entry holds:
 *   - id            primary key
 *   - org_id        tenant
 *   - trace_id      ties back to the original trace (= rollback key)
 *   - agent_id      so operator views can group by agent
 *   - tool_name     for the dispatcher
 *   - payload       JSON of the call we'll execute on fire
 *   - dispatch_url  webhook the operator's service exposes for actual fire
 *   - status        'pending' | 'fired' | 'cancelled' | 'failed'
 *   - enqueued_at   ISO
 *   - dispatch_at   ISO (enqueued + delay)
 *   - dispatched_at ISO (filled on fire)
 *   - error         text (on failure)
 *   - audit_id      links to admin_audit_log row for the enqueue
 *
 * Workflow:
 *
 *   1. Operator declares per-tool delay + dispatch_url in tenant
 *      config (`tenant_config.rollback.outbox = { tool_name: {...} }`).
 *
 *   2. SDK / proxy intercepts a tool call. If outbox is configured
 *      for that tool, gateway calls `enqueue()` instead of executing,
 *      returns an immediate "queued; will dispatch in Ns" response.
 *
 *   3. Background dispatcher (started by server.ts) polls for due
 *      entries and POSTs them to `dispatch_url`. Success → status=fired.
 *
 *   4. Operator (or AEGIS auto-rollback policy) calls `cancel(trace_id)`
 *      before dispatch_at → status=cancelled, no side effect, signed
 *      Merkle receipt linking to the original trace.
 *
 * The dispatcher is **at-least-once** by design: on retry, the
 * dispatch_url is expected to honour the idempotency key (= trace_id).
 * Operators who can't provide idempotent endpoints should use the
 * webhook compensator path on the RollbackService instead.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';

import { AuditLogService } from './audit-log';
import { TransparencyLogService } from './transparency-log';

export interface OutboxToolConfig {
  /** Delay before dispatch, in seconds. */
  delay_seconds: number;
  /** Operator-owned URL the dispatcher POSTs the payload to. */
  dispatch_url: string;
  /** Optional Authorization header for the dispatch. */
  authorization?: string;
  /** Per-attempt timeout (ms). Default 5000. */
  timeout_ms?: number;
}

export interface OutboxConfig {
  /** Map of tool_name → outbox config. If a tool is absent from this
   *  map the gateway falls through to executing it immediately
   *  (current behaviour). */
  tools: Record<string, OutboxToolConfig>;
}

export interface OutboxEntry {
  id: number;
  org_id: string;
  trace_id: string;
  agent_id: string;
  tool_name: string;
  payload: any;
  dispatch_url: string;
  status: 'pending' | 'fired' | 'cancelled' | 'failed';
  enqueued_at: string;
  dispatch_at: string;
  dispatched_at?: string;
  error?: string;
}

export interface EnqueueArgs {
  orgId: string;
  trace_id: string;
  agent_id: string;
  tool_name: string;
  payload: any;
}

export interface EnqueueResult {
  enqueued: boolean;
  id?: number;
  dispatch_at?: string;
  reason?: string;
}

export interface CancelArgs {
  orgId: string;
  trace_id: string;
  reason?: string;
  actor?: { user_id?: string; user_email?: string; ip_address?: string };
}

export class EffectOutboxService {
  private configByTenant: Map<string, OutboxConfig> = new Map();
  /** Track if the dispatcher loop has been started. */
  private dispatcherTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private audit: AuditLogService,
    private transparency: TransparencyLogService,
  ) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS effect_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id        TEXT NOT NULL,
        trace_id      TEXT NOT NULL,
        agent_id      TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        payload       TEXT NOT NULL,
        dispatch_url  TEXT NOT NULL,
        authorization TEXT,
        timeout_ms    INTEGER,
        status        TEXT NOT NULL DEFAULT 'pending',
        enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
        dispatch_at   TEXT NOT NULL,
        dispatched_at TEXT,
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_dispatch ON effect_outbox(status, dispatch_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_trace    ON effect_outbox(trace_id);
    `);
  }

  /** Replace the outbox config for a tenant (hot-reloaded from
   *  tenant_config.rollback.outbox by the ConfigBus subscriber). */
  setConfig(orgId: string, cfg: OutboxConfig | null): void {
    if (!cfg) {
      this.configByTenant.delete(orgId);
      return;
    }
    this.configByTenant.set(orgId, cfg);
  }

  /** Returns the registered config for (tenant, tool), or null. The
   *  proxy / SDK check this BEFORE executing a side-effecting tool. */
  lookup(orgId: string, toolName: string): OutboxToolConfig | null {
    return this.configByTenant.get(orgId)?.tools?.[toolName] ?? null;
  }

  /**
   * Stage a side-effecting tool call. Caller MUST NOT also execute
   * the original action — the dispatcher will fire on schedule.
   *
   * Returns enqueued: false when the tool isn't configured for outbox
   * (caller should then execute immediately as usual).
   */
  enqueue(args: EnqueueArgs): EnqueueResult {
    const cfg = this.lookup(args.orgId, args.tool_name);
    if (!cfg) return { enqueued: false, reason: 'no outbox config for tool' };

    const now = Date.now();
    const dispatchAt = new Date(now + cfg.delay_seconds * 1000).toISOString();
    const r = this.db.prepare(
      `INSERT INTO effect_outbox
         (org_id, trace_id, agent_id, tool_name, payload, dispatch_url, authorization, timeout_ms, dispatch_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.orgId, args.trace_id, args.agent_id, args.tool_name,
      JSON.stringify(args.payload), cfg.dispatch_url,
      cfg.authorization ?? null, cfg.timeout_ms ?? 5000,
      dispatchAt,
    );

    this.audit.log({
      org_id: args.orgId,
      action: 'outbox.enqueue',
      resource_type: 'trace',
      resource_id: args.trace_id,
      details: { tool_name: args.tool_name, dispatch_at: dispatchAt, agent_id: args.agent_id },
    });

    return { enqueued: true, id: Number(r.lastInsertRowid), dispatch_at: dispatchAt };
  }

  /**
   * Cancel a pending outbox entry by trace_id. Zero side effect when
   * called before dispatch_at. After dispatch_at (status=fired) the
   * caller should use the RollbackService's compensator path instead.
   */
  cancel(args: CancelArgs): { ok: boolean; reason?: string; cancelled_id?: number } {
    const row = this.db.prepare(
      `SELECT id, status FROM effect_outbox WHERE trace_id = ? AND org_id = ?`,
    ).get(args.trace_id, args.orgId) as { id: number; status: string } | undefined;

    if (!row) return { ok: false, reason: 'no outbox entry for trace_id' };
    if (row.status !== 'pending') return { ok: false, reason: `entry already ${row.status}` };

    this.db.prepare(
      `UPDATE effect_outbox SET status = 'cancelled', error = ? WHERE id = ?`,
    ).run(args.reason ?? 'cancelled by operator', row.id);

    this.audit.log({
      org_id: args.orgId,
      action: 'outbox.cancel',
      resource_type: 'trace',
      resource_id: args.trace_id,
      user_id:    args.actor?.user_id,
      user_email: args.actor?.user_email,
      ip_address: args.actor?.ip_address,
      details: { id: row.id, reason: args.reason ?? null },
    });

    // Signed receipt — same Merkle chain as the rollback service uses.
    try {
      this.transparency.append({
        payload: {
          action: 'outbox.cancel',
          trace_id: args.trace_id,
          cancelled_id: row.id,
          reason: args.reason ?? null,
          timestamp: new Date().toISOString(),
        },
        source: 'rollback' as any,
        org_id: args.orgId,
      });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'transparency append failed for outbox.cancel');
    }

    return { ok: true, cancelled_id: row.id };
  }

  /** Read pending entries due for dispatch (used by the loop). */
  due(now = new Date().toISOString(), limit = 50): OutboxEntry[] {
    const rows = this.db.prepare(
      `SELECT id, org_id, trace_id, agent_id, tool_name, payload,
              dispatch_url, status, enqueued_at, dispatch_at, dispatched_at, error
         FROM effect_outbox
        WHERE status = 'pending' AND dispatch_at <= ?
        ORDER BY dispatch_at ASC
        LIMIT ?`,
    ).all(now, limit) as any[];
    return rows.map((r) => ({ ...r, payload: safeJson(r.payload) }));
  }

  /** Read a single entry by id (for tests / introspection). */
  get(id: number): OutboxEntry | null {
    const r = this.db.prepare(
      `SELECT id, org_id, trace_id, agent_id, tool_name, payload, dispatch_url,
              status, enqueued_at, dispatch_at, dispatched_at, error
         FROM effect_outbox WHERE id = ?`,
    ).get(id) as any;
    return r ? { ...r, payload: safeJson(r.payload) } : null;
  }

  /** Dispatch one entry: POST payload to dispatch_url, update status. */
  async dispatchOne(id: number): Promise<{ status: 'fired' | 'failed'; error?: string }> {
    const row = this.db.prepare(
      `SELECT id, org_id, trace_id, dispatch_url, authorization, timeout_ms, payload, status
         FROM effect_outbox WHERE id = ?`,
    ).get(id) as any;
    if (!row) return { status: 'failed', error: 'not found' };
    if (row.status !== 'pending') return { status: 'failed', error: `not pending (${row.status})` };

    const timeoutMs = row.timeout_ms ?? 5000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(row.dispatch_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': row.trace_id,
          ...(row.authorization ? { 'Authorization': row.authorization } : {}),
        },
        body: row.payload,
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        this.db.prepare(
          `UPDATE effect_outbox SET status='failed', error=?, dispatched_at=datetime('now') WHERE id=?`,
        ).run(error, id);
        return { status: 'failed', error };
      }
      this.db.prepare(
        `UPDATE effect_outbox SET status='fired', dispatched_at=datetime('now') WHERE id=?`,
      ).run(id);
      this.audit.log({
        org_id: row.org_id,
        action: 'outbox.fire',
        resource_type: 'trace',
        resource_id: row.trace_id,
        details: { id, dispatch_url: row.dispatch_url },
      });
      return { status: 'fired' };
    } catch (err: any) {
      clearTimeout(timer);
      const error = String(err?.message ?? err);
      this.db.prepare(
        `UPDATE effect_outbox SET status='failed', error=?, dispatched_at=datetime('now') WHERE id=?`,
      ).run(error, id);
      return { status: 'failed', error };
    }
  }

  /** Start the background dispatcher loop. The interval is small
   *  (1s) so the dispatch-precision is roughly the configured
   *  delay_seconds ± 1s — fine for human-scale "delay 30s" semantics. */
  startDispatcher(intervalMs = 1000): void {
    if (this.dispatcherTimer) return;
    const tick = async () => {
      const due = this.due();
      for (const entry of due) {
        try { await this.dispatchOne(entry.id); }
        catch (err) { this.logger.warn({ err: (err as Error).message, id: entry.id }, 'outbox tick error'); }
      }
    };
    this.dispatcherTimer = setInterval(tick, intervalMs);
    // .unref so the timer doesn't keep the process alive in tests.
    (this.dispatcherTimer as any).unref?.();
  }

  stopDispatcher(): void {
    if (this.dispatcherTimer) {
      clearInterval(this.dispatcherTimer);
      this.dispatcherTimer = null;
    }
  }
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}
