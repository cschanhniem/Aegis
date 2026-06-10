/**
 * AuditLogStore — storage abstraction for `admin_audit_log`.
 *
 * Second table in the Postgres-migration pattern (PolicyStore was first).
 * Same shape: one interface, two adapters (Sqlite / Postgres), env-driven
 * factory. The HOT-PATH `log()` method stays SYNC on the sqlite adapter
 * because better-sqlite3 is sync — async-ifying every admin endpoint
 * would ripple through ~20 routes for no observable benefit on a
 * single-binary deploy.
 *
 * On Postgres, `log()` is sync at the call-site but enqueues into a
 * fire-and-forget batched write. Loss-on-crash is bounded to the
 * batch interval (configurable, default 200ms); production audit
 * guarantees come from the transparency-log Merkle anchoring, not the
 * SQL row itself.
 *
 * Read-side (`query()`) is async since the cockpit / SOC 2 evidence
 * endpoints already are; converting them cost zero by-call.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface AuditRow {
  org_id: string | null;
  user_id: string | null;
  user_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string | null;            // raw JSON; parsed by caller
  ip_address: string | null;
  created_at?: string;
}

export interface AuditQueryOpts {
  org_id?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogStore {
  init(): Promise<void>;
  /** Best-effort write. On sync stores this lands immediately;
   *  on async stores it enqueues into a batch flushed in the
   *  background. Either way, callers MUST NOT await. */
  log(row: AuditRow): void;
  /** Search the audit log. Backed by Sqlite or Postgres equivalently. */
  query(opts: AuditQueryOpts): Promise<{ entries: AuditRow[]; total: number }>;
  /** Force any pending writes to flush (test convenience). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

// ── Sqlite backend ────────────────────────────────────────────────────

export class SqliteAuditLogStore implements AuditLogStore {
  private insertStmt: Database.Statement | null = null;

  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT, user_id TEXT, user_email TEXT,
        action TEXT NOT NULL, resource_type TEXT NOT NULL,
        resource_id TEXT, details TEXT, ip_address TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_aal_org      ON admin_audit_log(org_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_aal_action   ON admin_audit_log(action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_aal_resource ON admin_audit_log(resource_type, resource_id);
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO admin_audit_log (org_id, user_id, user_email, action, resource_type, resource_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  log(r: AuditRow): void {
    if (!this.insertStmt) throw new Error('AuditLogStore: init() must be called before log()');
    this.insertStmt.run(r.org_id, r.user_id, r.user_email, r.action, r.resource_type, r.resource_id, r.details, r.ip_address);
  }

  async query(opts: AuditQueryOpts): Promise<{ entries: AuditRow[]; total: number }> {
    const { where, params } = this.buildWhere(opts);
    const limit  = Math.min(opts.limit  ?? 50, 200);
    const offset = opts.offset ?? 0;
    const total  = (this.db.prepare(`SELECT COUNT(*) AS n FROM admin_audit_log ${where}`).get(...params) as any).n;
    const entries = this.db.prepare(
      `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as AuditRow[];
    return { entries, total };
  }

  private buildWhere(opts: AuditQueryOpts): { where: string; params: any[] } {
    let where = 'WHERE 1=1';
    const params: any[] = [];
    if (opts.org_id)        { where += ' AND org_id = ?';        params.push(opts.org_id); }
    if (opts.action)        { where += ' AND action = ?';        params.push(opts.action); }
    if (opts.resource_type) { where += ' AND resource_type = ?'; params.push(opts.resource_type); }
    if (opts.resource_id)   { where += ' AND resource_id = ?';   params.push(opts.resource_id); }
    if (opts.from)          { where += ' AND created_at >= ?';   params.push(opts.from); }
    if (opts.to)            { where += ' AND created_at <= ?';   params.push(opts.to); }
    if (opts.q && opts.q.trim()) {
      where += ' AND (action LIKE ? OR resource_id LIKE ? OR details LIKE ?)';
      const needle = `%${opts.q.trim()}%`;
      params.push(needle, needle, needle);
    }
    return { where, params };
  }

  async flush(): Promise<void> { /* sync writes — nothing pending */ }
  async close(): Promise<void> { /* db lifecycle owned by caller */ }
}

// ── Postgres backend ─────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    org_id TEXT, user_id TEXT, user_email TEXT,
    action TEXT NOT NULL, resource_type TEXT NOT NULL,
    resource_id TEXT, details TEXT, ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_aal_org      ON admin_audit_log(org_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_aal_action   ON admin_audit_log(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_aal_resource ON admin_audit_log(resource_type, resource_id);
`;

export class PostgresAuditLogStore implements AuditLogStore {
  private pool: Pool;
  private buffer: AuditRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushIntervalMs: number;
  private maxBatch: number;
  private flushing: Promise<void> | null = null;

  constructor(pool: Pool, opts: { flushIntervalMs?: number; maxBatch?: number } = {}) {
    this.pool = pool;
    this.flushIntervalMs = opts.flushIntervalMs ?? 200;
    this.maxBatch        = opts.maxBatch ?? 500;
  }

  async init(): Promise<void> {
    await this.pool.query(PG_SCHEMA);
    this.startTimer();
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { this.flush().catch(() => {}); }, this.flushIntervalMs);
    if (typeof (this.flushTimer as any).unref === 'function') (this.flushTimer as any).unref();
  }

  log(r: AuditRow): void {
    this.buffer.push(r);
    if (this.buffer.length >= this.maxBatch) {
      // Don't await — fire-and-forget; failures bounded by next interval.
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    this.flushing = (async () => {
      try {
        // Multi-row INSERT — much cheaper than per-row on pg. Build the
        // parameterised statement defensively (no concatenation of user
        // data into SQL; only the placeholder positions are interpolated).
        const cols = ['org_id', 'user_id', 'user_email', 'action', 'resource_type', 'resource_id', 'details', 'ip_address'];
        const values: any[] = [];
        const groups: string[] = [];
        for (const r of batch) {
          const baseIdx = values.length;
          values.push(r.org_id, r.user_id, r.user_email, r.action, r.resource_type, r.resource_id, r.details, r.ip_address);
          groups.push('(' + cols.map((_, i) => `$${baseIdx + i + 1}`).join(', ') + ')');
        }
        await this.pool.query(
          `INSERT INTO admin_audit_log (${cols.join(', ')}) VALUES ${groups.join(', ')}`,
          values,
        );
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async query(opts: AuditQueryOpts): Promise<{ entries: AuditRow[]; total: number }> {
    // Flush pending writes before reading so queries see this-process writes.
    await this.flush();
    const { where, params } = this.buildWhere(opts);
    const limit  = Math.min(opts.limit  ?? 50, 200);
    const offset = opts.offset ?? 0;
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM admin_audit_log ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const rowsRes = await this.pool.query(
      `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: rowsRes.rows as AuditRow[], total };
  }

  private buildWhere(opts: AuditQueryOpts): { where: string; params: any[] } {
    let where = 'WHERE 1=1';
    const params: any[] = [];
    const next = () => `$${params.length + 1}`;
    if (opts.org_id)        { where += ` AND org_id = ${next()}`;        params.push(opts.org_id); }
    if (opts.action)        { where += ` AND action = ${next()}`;        params.push(opts.action); }
    if (opts.resource_type) { where += ` AND resource_type = ${next()}`; params.push(opts.resource_type); }
    if (opts.resource_id)   { where += ` AND resource_id = ${next()}`;   params.push(opts.resource_id); }
    if (opts.from)          { where += ` AND created_at >= ${next()}`;   params.push(opts.from); }
    if (opts.to)            { where += ` AND created_at <= ${next()}`;   params.push(opts.to); }
    if (opts.q && opts.q.trim()) {
      const i1 = next(); const i2 = `$${params.length + 2}`; const i3 = `$${params.length + 3}`;
      where += ` AND (action LIKE ${i1} OR resource_id LIKE ${i2} OR details LIKE ${i3})`;
      const needle = `%${opts.q.trim()}%`;
      params.push(needle, needle, needle);
    }
    return { where, params };
  }

  async close(): Promise<void> {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    await this.flush().catch(() => {});
    await this.pool.end().catch(() => {});
  }
}
