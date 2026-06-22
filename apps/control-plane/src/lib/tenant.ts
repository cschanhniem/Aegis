/**
 * Tenant provisioning — single source of truth for "create a new
 * AEGIS org." Called from signup, from admin, from CLI.
 */

import { adminSql } from './db'
import crypto from 'node:crypto'

export interface ProvisionedTenant {
  orgId: string
  slug: string
  apiKey: string          // plaintext, shown to user once
  apiKeyPrefix: string
}

const PLAN_QUOTAS: Record<string, { checks: number; retention: number }> = {
  free:       { checks:   1_000, retention:   7 },
  pro:        { checks: 100_000, retention:  30 },
  team:       { checks: 1_000_000, retention: 90 },
  enterprise: { checks: 100_000_000, retention: 365 },
}

/** Generate `aeg_` + 32 hex chars. */
function newApiKey(): string {
  return 'aeg_' + crypto.randomBytes(20).toString('hex')
}

/** Slugify a display name into a DNS-safe subdomain (3-32 chars). */
function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.length < 3 ? `org-${crypto.randomBytes(3).toString('hex')}` : s.slice(0, 32)
}

/** Provision a fresh org for `ownerUserId`. Idempotent on slug collision
 *  (suffixes a short random). Returns the API key in plaintext exactly
 *  once — caller is responsible for showing it to the user. */
export async function provisionTenant(
  ownerUserId: string,
  opts: { displayName: string; plan?: keyof typeof PLAN_QUOTAS },
): Promise<ProvisionedTenant> {
  const plan = opts.plan ?? 'free'
  const quota = PLAN_QUOTAS[plan]
  const baseSlug = slugify(opts.displayName)

  return adminSql.begin(async tx => {
    // Slug collision retry — up to 5 attempts.
    let slug = baseSlug
    let attempts = 0
    while (attempts < 5) {
      const exists = await tx`SELECT 1 FROM orgs WHERE slug = ${slug} LIMIT 1`
      if (exists.count === 0) break
      slug = `${baseSlug}-${crypto.randomBytes(2).toString('hex')}`
      attempts++
    }

    const [org] = await tx`
      INSERT INTO orgs (slug, display_name, plan, monthly_check_quota, retention_days)
      VALUES (${slug}, ${opts.displayName}, ${plan}, ${quota.checks}, ${quota.retention})
      RETURNING id
    `
    await tx`
      INSERT INTO members (org_id, user_id, role)
      VALUES (${org.id}, ${ownerUserId}, 'owner')
    `
    const plaintext = newApiKey()
    const hash = crypto.createHash('sha256').update(plaintext).digest('hex')
    const prefix = plaintext.slice(0, 12) // 'aeg_' + 8 chars
    await tx`
      INSERT INTO hosted_api_keys (org_id, name, key_hash, key_prefix, scope)
      VALUES (${org.id}, 'Default', ${hash}, ${prefix}, 'admin')
    `

    return {
      orgId: org.id,
      slug,
      apiKey: plaintext,
      apiKeyPrefix: prefix,
    }
  })
}

/** Resolve a bearer-token API key to (orgId, scope). null if revoked
 *  or unknown. Updates last_used_at as a side-effect. */
export async function authenticateApiKey(
  plaintext: string,
): Promise<{ orgId: string; scope: string } | null> {
  if (!plaintext || !plaintext.startsWith('aeg_')) return null
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex')
  const rows = await adminSql`
    SELECT org_id, scope
      FROM hosted_api_keys
     WHERE key_hash = ${hash}
       AND revoked_at IS NULL
     LIMIT 1
  `
  if (rows.count === 0) return null
  // Fire-and-forget last_used_at update.
  void adminSql`UPDATE hosted_api_keys SET last_used_at = NOW() WHERE key_hash = ${hash}`.catch(() => {})
  return { orgId: rows[0].org_id, scope: rows[0].scope }
}
