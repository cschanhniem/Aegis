/**
 * GET /api/me — current user + their orgs.
 *
 * Reads `aegis_session` cookie (set by /api/auth/login + /api/auth/signup).
 * No middleware framework here; tiny enough to do inline until we
 * swap in next-auth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { adminSql } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const userId = req.cookies.get('aegis_session')?.value
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [user] = await adminSql`
    SELECT id, email, display_name FROM users WHERE id = ${userId} LIMIT 1
  `
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const orgs = await adminSql`
    SELECT o.id, o.slug, o.display_name, o.plan, o.monthly_check_quota, o.retention_days
      FROM orgs o
      JOIN members m ON m.org_id = o.id
     WHERE m.user_id = ${userId}
     ORDER BY o.created_at ASC
  `
  return NextResponse.json({ user, orgs })
}
