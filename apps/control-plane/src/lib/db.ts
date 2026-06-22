/**
 * Postgres client + tenant-scoped query helper.
 *
 * Every request that touches a tenant-scoped table MUST go through
 * `withTenant(orgId, async (sql) => …)`. That wraps the work in a
 * transaction with `SET LOCAL app.tenant_id = '<orgId>'`, which
 * activates the RLS policies installed by migration 0001.
 */

import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

// Pool. Re-used across requests; lambda-friendly.
export const sql = postgres(url, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 5,
  prepare: false,                 // PgBouncer-safe
})

/** Run `fn` inside a transaction scoped to `orgId`. */
export async function withTenant<T>(
  orgId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async tx => {
    // RLS hinge — SET LOCAL only takes effect for this txn.
    await tx`SELECT set_config('app.tenant_id', ${orgId}, true)`
    return fn(tx)
  })
}

/** Control-plane (cross-tenant) queries — admin only. Bypasses RLS by
 *  never setting app.tenant_id; use ONLY for orgs / users / members /
 *  billing_events / hosted_api_keys, which are NOT under RLS. */
export const adminSql = sql
