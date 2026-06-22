/**
 * POST /api/tenants — create a new org for the authenticated user.
 *
 * Body: { displayName }
 * Returns: { orgId, slug, apiKey, apiKeyPrefix } — apiKey shown ONCE,
 * never retrievable again. UI must display it immediately.
 */

import { NextRequest, NextResponse } from 'next/server'
import { provisionTenant } from '@/lib/tenant'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // TODO: replace with real auth() from next-auth once provider is wired
  const userId = req.headers.get('x-user-id')
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { displayName?: string; plan?: string }
  if (!body.displayName || body.displayName.length < 2) {
    return NextResponse.json({ error: 'displayName (min 2 chars) required' }, { status: 400 })
  }

  const tenant = await provisionTenant(userId, {
    displayName: body.displayName,
    plan: (body.plan as any) ?? 'free',
  })
  return NextResponse.json(tenant)
}
