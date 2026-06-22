/**
 * POST /api/auth/signup — create user + tenant + first API key.
 *
 * Body: { email, password, displayName }
 * Returns: { orgId, slug, apiKey, apiKeyPrefix }  (apiKey shown ONCE)
 */

import { NextRequest, NextResponse } from 'next/server'
import { adminSql } from '@/lib/db'
import { provisionTenant } from '@/lib/tenant'
import crypto from 'node:crypto'

export const runtime = 'nodejs'

function hashPw(plaintext: string, salt: string): string {
  return crypto.scryptSync(plaintext, salt, 64).toString('hex')
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    email?: string; password?: string; displayName?: string
  }
  if (!body.email || !body.password || !body.displayName) {
    return NextResponse.json({ error: 'email, password, displayName required' }, { status: 400 })
  }
  if (body.password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })
  }

  // Reject duplicate emails.
  const existing = await adminSql`SELECT 1 FROM users WHERE email = ${body.email.toLowerCase()} LIMIT 1`
  if (existing.count > 0) {
    return NextResponse.json({ error: 'an account with this email already exists' }, { status: 409 })
  }

  const salt = crypto.randomBytes(16).toString('hex')
  const hash = `${salt}:${hashPw(body.password, salt)}`

  const [user] = await adminSql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${body.email.toLowerCase()}, ${hash}, ${body.displayName})
    RETURNING id
  `

  const tenant = await provisionTenant(user.id, { displayName: body.displayName })

  // Set a simple session cookie. In production swap for next-auth.
  const res = NextResponse.json(tenant)
  res.cookies.set('aegis_session', user.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,        // 30 days
    path: '/',
  })
  return res
}
