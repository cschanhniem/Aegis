/**
 * Reversibility classifier — pre-flight decision about whether an
 * agent action *can* be rolled back later, and via what mechanism.
 *
 * Three classes:
 *
 *   - 'idempotent'    Safe to replay; re-running is a no-op or has the
 *                     same effect. Reads, status checks, GETs.
 *
 *   - 'compensable'   Has a known inverse operation we can execute on
 *                     rollback. Database writes (compensate = inverse
 *                     write), file mutations (compensate = restore from
 *                     trace snapshot), HTTP POSTs to APIs with
 *                     delete/refund endpoints.
 *
 *   - 'irreversible'  Cannot be undone — email sent, money cleared,
 *                     tweet posted, physical actuation, third-party
 *                     side-effect with no compensating endpoint. The
 *                     rollback service refuses these unless the
 *                     operator explicitly opts in to "correction-only"
 *                     mode (rollback emits a *new* correcting action,
 *                     not a true undo).
 *
 * The classifier is deterministic-first (built-in tool taxonomy) with
 * tenant override hook so operators can tag their own tools. Returns
 * the class plus a one-line `reason` the audit log carries through.
 *
 * Why this matters: ACRFence (arXiv 2603.20625) showed that naive
 * checkpoint-restore creates new attack surface — *Action Replay* and
 * *Authority Resurrection*. Forcing every rollback to declare its
 * reversibility class up front is the principled way to avoid both.
 */

export type ReversibilityClass = 'idempotent' | 'compensable' | 'irreversible';

export interface Classification {
  class: ReversibilityClass;
  reason: string;
  /** Optional structured hint for the compensator (e.g. "delete the
   *  row matching this id"). Schema is tool-specific; the rollback
   *  service hands it to the compensator unchanged. */
  compensation_hint?: Record<string, unknown>;
}

/** Built-in defaults for the well-known tool names. Augmented (and can
 *  be overridden) by tenant policy. */
const BUILTIN_TAXONOMY: Record<string, Classification> = {
  // Idempotent reads — replay-safe by definition
  'web_search':       { class: 'idempotent', reason: 'pure read (HTTP GET)' },
  'fetch_url':        { class: 'idempotent', reason: 'pure read (HTTP GET)' },
  'http_get':         { class: 'idempotent', reason: 'pure read (HTTP GET)' },
  'file_read':        { class: 'idempotent', reason: 'pure read (filesystem)' },
  'read_file':        { class: 'idempotent', reason: 'pure read (filesystem)' },
  'list_files':       { class: 'idempotent', reason: 'pure read (filesystem)' },
  'list_directory':   { class: 'idempotent', reason: 'pure read (filesystem)' },
  'sql_select':       { class: 'idempotent', reason: 'read-only SQL' },

  // Compensable — destructive but reversible if we have the original state
  'file_write':       { class: 'compensable',   reason: 'restorable from .aegis.bak snapshot' },
  'write_file':       { class: 'compensable',   reason: 'restorable from .aegis.bak snapshot' },
  'file_append':      { class: 'compensable',   reason: 'compensator truncates appended bytes' },
  'file_delete':      { class: 'compensable',   reason: 'compensator restores from snapshot if pre-snapshot exists' },
  'db_insert':        { class: 'compensable',   reason: 'compensator deletes the inserted row' },
  'db_update':        { class: 'compensable',   reason: 'compensator restores prior column values from trace' },
  'db_delete':        { class: 'compensable',   reason: 'compensator restores from pre-delete snapshot' },
  'sql_insert':       { class: 'compensable',   reason: 'compensator deletes the inserted row' },
  'sql_update':       { class: 'compensable',   reason: 'compensator restores prior column values from trace' },

  // Irreversible — once gone, gone
  'send_email':       { class: 'irreversible',  reason: 'SMTP delivery cannot be recalled' },
  'sendmail':         { class: 'irreversible',  reason: 'SMTP delivery cannot be recalled' },
  'send_sms':         { class: 'irreversible',  reason: 'SMS delivery cannot be recalled' },
  'post_slack':       { class: 'irreversible',  reason: 'Slack delivery cannot be reliably retracted' },
  'tweet':            { class: 'irreversible',  reason: 'public post; correction-only' },
  'charge_card':      { class: 'irreversible',  reason: 'requires refund, not undo' },
  'stripe_charge':    { class: 'irreversible',  reason: 'requires refund, not undo' },
  'wire_transfer':    { class: 'irreversible',  reason: 'ACH/wire cleared funds' },

  // Shell + code-exec — depends on what the command did; without
  // wrapping, assume irreversible.
  'shell':            { class: 'irreversible',  reason: 'arbitrary shell — assume side-effects unknown' },
  'shell_exec':       { class: 'irreversible',  reason: 'arbitrary shell — assume side-effects unknown' },
  'run_command':      { class: 'irreversible',  reason: 'arbitrary shell — assume side-effects unknown' },
  'execute_code':     { class: 'irreversible',  reason: 'arbitrary code — assume side-effects unknown' },
};

/** Per-tenant overrides. Higher precedence than BUILTIN_TAXONOMY. */
export interface TenantOverride {
  tool_name: string;
  class: ReversibilityClass;
  reason?: string;
  compensation_hint?: Record<string, unknown>;
}

export class ReversibilityClassifier {
  private overrides: Map<string, Classification> = new Map();

  /** Bulk-load tenant overrides (called by the gateway when tenant
   *  config changes). */
  setOverrides(overrides: TenantOverride[]): void {
    this.overrides.clear();
    for (const o of overrides) {
      if (!o?.tool_name) continue;
      this.overrides.set(o.tool_name, {
        class: o.class,
        reason: o.reason ?? 'tenant override',
        compensation_hint: o.compensation_hint,
      });
    }
  }

  /**
   * Classify a tool call. Precedence:
   *   1. tenant override
   *   2. SQL substring heuristic (the args carry the actual statement
   *      type, which lets us catch hand-rolled query tools)
   *   3. built-in taxonomy
   *   4. fallback: irreversible (fail-safe — if we don't know what the
   *      tool does, we don't pretend we can undo it)
   */
  classify(toolName: string, args: Record<string, unknown>): Classification {
    if (this.overrides.has(toolName)) return this.overrides.get(toolName)!;

    // SQL heuristic — peek inside common arg shapes
    const sql = pickFirstString(args, ['sql', 'query', 'statement']);
    if (sql) {
      const head = sql.trim().toUpperCase().split(/\s+/)[0];
      if (head === 'SELECT' || head === 'SHOW' || head === 'DESCRIBE' || head === 'EXPLAIN') {
        return { class: 'idempotent', reason: `SQL ${head}` };
      }
      if (head === 'INSERT' || head === 'UPDATE' || head === 'DELETE') {
        return {
          class: 'compensable',
          reason: `SQL ${head} — restorable via row snapshot`,
          compensation_hint: { sql_kind: head, original_statement: sql.slice(0, 500) },
        };
      }
      if (head === 'DROP' || head === 'TRUNCATE' || head === 'ALTER') {
        return { class: 'irreversible', reason: `SQL ${head} — schema/structural change` };
      }
    }

    // HTTP heuristic
    const method = pickFirstString(args, ['method', 'http_method']);
    if (method) {
      const m = method.toUpperCase();
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
        return { class: 'idempotent', reason: `HTTP ${m}` };
      }
      if (m === 'DELETE' || m === 'POST' || m === 'PUT' || m === 'PATCH') {
        return { class: 'irreversible', reason: `HTTP ${m} without registered compensator` };
      }
    }

    const builtin = BUILTIN_TAXONOMY[toolName];
    if (builtin) return builtin;

    return { class: 'irreversible', reason: `tool '${toolName}' has no registered reversibility class — defaulting to fail-safe` };
  }
}

function pickFirstString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
