'use client'

// ── localStorage keys ──────────────────────────────────────────────────────
//
// Cockpit stores at most two auth credentials side-by-side:
//   aegis:api_key      — long-lived per-org key, used when no session
//                        (CLI-style, service-account flow)
//   aegis:session_token — short-lived (12h) Bearer token from /auth/callback
//                        after SSO login. Preferred when present so audit
//                        rows get real user attribution.
//
// Logout clears the session token; the API key persists across logout so
// the Cockpit stays usable in API-key-only deployments (no SSO configured).

export function getApiKey(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('aegis:api_key') ?? ''
}

export function getSessionToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('aegis:session_token') ?? ''
}

export function setSessionToken(token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem('aegis:session_token', token)
}

export function clearSessionToken(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem('aegis:session_token')
}

/** Headers for direct gateway-targeted fetches. Prefers Bearer over X-API-Key
 *  so the audit log records the human user when a session exists. */
export function gatewayHeaders(): HeadersInit {
  const session = getSessionToken()
  const key = getApiKey()
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (session) h['authorization'] = `Bearer ${session}`
  else if (key) h['x-api-key'] = key
  return h
}

/** Convenience wrapper: fetch /api/gateway/... with the strongest available
 *  credential. Bearer first, X-API-Key second. */
export async function gw(path: string, init?: RequestInit): Promise<Response> {
  const session = getSessionToken()
  const key = getApiKey()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> ?? {}),
    'Content-Type': 'application/json',
  }
  if (session) headers['authorization'] = `Bearer ${session}`
  else if (key) headers['x-api-key'] = key
  return fetch(`/api/gateway/${path}`, { ...init, headers, cache: 'no-store' })
}
