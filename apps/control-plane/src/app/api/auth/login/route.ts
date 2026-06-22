/**
 * POST /api/auth/login — verify email + password, set session cookie.
 */

import { NextRequest, NextResponse } from 'next/server'
import { adminSql } from '@/lib/db'
import crypto from 'node:crypto'

export const runtime = 'nodejs'

function verifyPw(plaintext: string, stored: string | null): boolean {
  if (!stored || !stored.includes(':')) return false
  const [salt, expected] = stored.split(':')
  const actual = crypto.scryptSync(plaintext, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export async function POST(req: NextRequest) {
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string; password?: string
  }
  if (!email || !password) {
    return NextResponse.json({ error: 'email and password required' }, { status: 400 })
  }

  const rows = await adminSql`
    SELECT id, password_hash FROM users WHERE email = ${email.toLowerCase()} LIMIT 1
  `
  if (rows.count === 0) {
    return NextResponse.json({ error: 'invalid email or password' }, { status: 401 })
  }
  if (!verifyPw(password, rows[0].password_hash)) {
    return NextResponse.json({ error: 'invalid email or password' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set('aegis_session', rows[0].id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })
  return res
}
