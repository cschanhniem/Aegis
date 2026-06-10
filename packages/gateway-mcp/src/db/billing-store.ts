/**
 * BillingStore — per-org subscription state + monthly usage counters.
 *
 * Stripe is the authoritative source of truth for subscription
 * lifecycle (created, current_period_end, status, payment_method).
 * We mirror just enough state locally so the gateway hot-path can
 * gate every request in O(1) without an outbound API call.
 *
 * Tables:
 *   - org_subscriptions    one row per org; current plan + status
 *   - usage_counters       monotonic counters per (org, month, metric)
 *
 * Updates land via the Stripe webhook handler (api/stripe.ts) on
 * customer.subscription.* events. The gateway reads the cached rows
 * synchronously on every check. Eventual consistency is acceptable —
 * Stripe webhook latency is < 1 s typical; the worst case is "old plan
 * for 60 seconds after upgrade" which is harmless.
 */

import type Database from 'better-sqlite3';

export type PlanId = 'free' | 'pro' | 'team' | 'enterprise';
export type SubscriptionStatus =
  | 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'unpaid';

export interface SubscriptionRow {
  org_id: string;
  plan: PlanId;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  updated_at: string;
}

export interface UsageRow {
  org_id: string;
  period_key: string;            // 'YYYY-MM' month bucket
  metric: 'checks' | 'tokens' | 'agents';
  count: number;
  updated_at: string;
}

export interface BillingStore {
  init(): Promise<void>;
  /** Fetch the current subscription row for an org. Creates a Free-
   *  tier row on first access (so every org has a baseline). */
  getSubscription(orgId: string): Promise<SubscriptionRow>;
  upsertSubscription(row: Omit<SubscriptionRow, 'updated_at'>): Promise<void>;
  /** Bump a usage counter atomically. Returns the post-increment value
   *  so the caller can decide whether to throttle on the same call. */
  incrementUsage(orgId: string, metric: 'checks' | 'tokens' | 'agents', by?: number): Promise<number>;
  /** Read the current counter (returns 0 if no row yet). */
  getUsage(orgId: string, metric: 'checks' | 'tokens' | 'agents', periodKey?: string): Promise<number>;
  /** Bulk read for billing reporting — all metrics for one org in one
   *  call (e.g. for the customer's "current usage" page). */
  getAllUsage(orgId: string, periodKey?: string): Promise<Record<string, number>>;
  close(): Promise<void>;
}

function monthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class SqliteBillingStore implements BillingStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS org_subscriptions (
        org_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL DEFAULT 'free',
        status TEXT NOT NULL DEFAULT 'active',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        current_period_start TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_org_sub_stripe ON org_subscriptions(stripe_subscription_id);

      CREATE TABLE IF NOT EXISTS usage_counters (
        org_id     TEXT NOT NULL,
        period_key TEXT NOT NULL,
        metric     TEXT NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (org_id, period_key, metric)
      );
    `);
  }

  async getSubscription(orgId: string): Promise<SubscriptionRow> {
    const row = this.db.prepare(
      `SELECT * FROM org_subscriptions WHERE org_id = ?`,
    ).get(orgId) as SubscriptionRow | undefined;
    if (row) return row;
    // First-access provisioning: every org has a Free tier baseline.
    this.db.prepare(
      `INSERT INTO org_subscriptions (org_id, plan, status) VALUES (?, 'free', 'active')
       ON CONFLICT(org_id) DO NOTHING`,
    ).run(orgId);
    return this.db.prepare(`SELECT * FROM org_subscriptions WHERE org_id = ?`).get(orgId) as SubscriptionRow;
  }

  async upsertSubscription(row: Omit<SubscriptionRow, 'updated_at'>): Promise<void> {
    this.db.prepare(
      `INSERT INTO org_subscriptions
       (org_id, plan, status, stripe_customer_id, stripe_subscription_id,
        current_period_start, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id) DO UPDATE SET
         plan = excluded.plan,
         status = excluded.status,
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      row.org_id, row.plan, row.status,
      row.stripe_customer_id, row.stripe_subscription_id,
      row.current_period_start, row.current_period_end,
      row.cancel_at_period_end,
    );
  }

  async incrementUsage(orgId: string, metric: 'checks' | 'tokens' | 'agents', by = 1): Promise<number> {
    const period_key = monthKey();
    this.db.prepare(
      `INSERT INTO usage_counters (org_id, period_key, metric, count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, period_key, metric) DO UPDATE SET
         count = count + excluded.count,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(orgId, period_key, metric, by);
    return this.getUsage(orgId, metric, period_key);
  }

  async getUsage(orgId: string, metric: 'checks' | 'tokens' | 'agents', periodKey?: string): Promise<number> {
    const period_key = periodKey ?? monthKey();
    const row = this.db.prepare(
      `SELECT count FROM usage_counters WHERE org_id = ? AND period_key = ? AND metric = ?`,
    ).get(orgId, period_key, metric) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  async getAllUsage(orgId: string, periodKey?: string): Promise<Record<string, number>> {
    const period_key = periodKey ?? monthKey();
    const rows = this.db.prepare(
      `SELECT metric, count FROM usage_counters WHERE org_id = ? AND period_key = ?`,
    ).all(orgId, period_key) as Array<{ metric: string; count: number }>;
    return Object.fromEntries(rows.map(r => [r.metric, r.count]));
  }

  async close(): Promise<void> {}
}
