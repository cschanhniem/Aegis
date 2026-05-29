/**
 * BudgetGuardService — turns existing cost-tracking into a forward-looking
 * gate. Reads spend from both signal sources (traces written by the SDK
 * path, and admin_audit_log rows written by the LLM proxy path), compares
 * against the per-tenant limits in tenant_config.budget, and returns a
 * decision the BudgetDetector turns into a Signal.
 *
 * Query model: spend is computed on demand per call. Cheap at v1 volumes
 * (SQLite with indexes on org_id + timestamp) and avoids the staleness +
 * write-amplification of materialized aggregates. When a tenant pushes
 * thousands of QPS we add a cached running total — until then, on-demand
 * is the right default.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { TenantConfigService } from './tenant-config';

export type BudgetScope = 'tenant-daily' | 'tenant-monthly' | 'agent-daily' | 'session';
export type BudgetSeverity = 'ok' | 'warn' | 'critical';

export interface BudgetStatusEntry {
  readonly scope: BudgetScope;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly fraction: number;       // spentUsd / limitUsd
  readonly severity: BudgetSeverity;
  readonly windowStart: string;    // ISO8601
}

export interface BudgetDecision {
  readonly worst: BudgetSeverity;
  readonly entries: ReadonlyArray<BudgetStatusEntry>;
  /** Configured action ('log' | 'warn' | 'block'). */
  readonly action: 'log' | 'warn' | 'block';
}

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonthUtc(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export class BudgetGuardService {
  constructor(
    private db: Database.Database,
    private tenantConfig: TenantConfigService,
    private logger: Logger,
  ) {}

  /**
   * Compute spend within a window, joining SDK-path (traces.cost_usd) and
   * proxy-path (admin_audit_log.details.cost.usd) records. Both filters
   * by org_id. Optional agentId / sessionId narrow further.
   *
   * Returns USD spend as a number; never throws (DB issues degrade to 0).
   */
  spendSince(opts: { orgId: string; sinceIso: string; agentId?: string; sessionId?: string }): number {
    let total = 0;

    // SDK trace rows.
    try {
      const cond = ['org_id = ?', "timestamp >= ?", 'cost_usd IS NOT NULL'];
      const params: any[] = [opts.orgId, opts.sinceIso];
      if (opts.agentId)   { cond.push('agent_id = ?');    params.push(opts.agentId); }
      if (opts.sessionId) { cond.push('session_id = ?');  params.push(opts.sessionId); }
      const row = this.db.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM traces WHERE ${cond.join(' AND ')}`,
      ).get(...params) as { s: number };
      total += Number(row.s) || 0;
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'budget: traces query failed');
    }

    // Proxy audit rows (cost lives in JSON details).
    try {
      const cond = [
        'org_id = ?',
        'created_at >= ?',
        `action = 'proxy.llm_call'`,
        `json_extract(details, '$.cost.usd') IS NOT NULL`,
      ];
      const params: any[] = [opts.orgId, opts.sinceIso];
      if (opts.agentId) {
        cond.push(`json_extract(details, '$.proxy.agent_id') = ?`);
        params.push(opts.agentId);
      }
      if (opts.sessionId) {
        cond.push(`json_extract(details, '$.proxy.session_id') = ?`);
        params.push(opts.sessionId);
      }
      const row = this.db.prepare(
        `SELECT COALESCE(SUM(CAST(json_extract(details, '$.cost.usd') AS REAL)), 0) AS s FROM admin_audit_log WHERE ${cond.join(' AND ')}`,
      ).get(...params) as { s: number };
      total += Number(row.s) || 0;
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'budget: audit query failed');
    }

    return total;
  }

  /**
   * Evaluate all configured limits for a tenant. Returns a per-scope
   * status array + a worst-severity summary that callers act on.
   */
  evaluate(opts: { orgId: string; agentId?: string; sessionId?: string }): BudgetDecision | null {
    const cfg = this.tenantConfig.get(opts.orgId).budget;
    if (!cfg || !cfg.enabled) return null;

    const entries: BudgetStatusEntry[] = [];
    const warnAt = cfg.warnAt;
    const todayStart = startOfTodayUtc();
    const monthStart = startOfMonthUtc();

    if (cfg.dailyUsd != null) {
      const spent = this.spendSince({ orgId: opts.orgId, sinceIso: todayStart });
      entries.push(this.toEntry('tenant-daily', cfg.dailyUsd, spent, todayStart, warnAt));
    }
    if (cfg.monthlyUsd != null) {
      const spent = this.spendSince({ orgId: opts.orgId, sinceIso: monthStart });
      entries.push(this.toEntry('tenant-monthly', cfg.monthlyUsd, spent, monthStart, warnAt));
    }
    if (cfg.perAgentDailyUsd != null && opts.agentId) {
      const spent = this.spendSince({ orgId: opts.orgId, sinceIso: todayStart, agentId: opts.agentId });
      entries.push(this.toEntry('agent-daily', cfg.perAgentDailyUsd, spent, todayStart, warnAt));
    }
    if (cfg.perSessionUsd != null && opts.sessionId) {
      // Session window = entire session lifetime; we approximate with "all-time"
      // which for an in-progress session is the same answer.
      const spent = this.spendSince({ orgId: opts.orgId, sinceIso: '1970-01-01T00:00:00Z', sessionId: opts.sessionId });
      entries.push(this.toEntry('session', cfg.perSessionUsd, spent, '1970-01-01T00:00:00Z', warnAt));
    }

    const worst = entries.reduce<BudgetSeverity>(
      (acc, e) => (severityRank(e.severity) > severityRank(acc) ? e.severity : acc),
      'ok',
    );
    return { worst, entries, action: cfg.action };
  }

  /** Read-only status used by /api/v1/budget/status. */
  status(opts: { orgId: string; agentId?: string; sessionId?: string }): BudgetDecision | { enabled: false } {
    const cfg = this.tenantConfig.get(opts.orgId).budget;
    if (!cfg || !cfg.enabled) return { enabled: false };
    return this.evaluate(opts) ?? { worst: 'ok' as const, entries: [], action: cfg.action };
  }

  private toEntry(
    scope: BudgetScope,
    limit: number,
    spent: number,
    windowStart: string,
    warnAt: number,
  ): BudgetStatusEntry {
    const fraction = limit > 0 ? spent / limit : 0;
    let severity: BudgetSeverity = 'ok';
    if (fraction >= 1) severity = 'critical';
    else if (fraction >= warnAt) severity = 'warn';
    return { scope, limitUsd: limit, spentUsd: spent, fraction, severity, windowStart };
  }
}

function severityRank(s: BudgetSeverity): number {
  return s === 'critical' ? 2 : s === 'warn' ? 1 : 0;
}
