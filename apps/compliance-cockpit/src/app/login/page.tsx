'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { gw, setSessionToken, getSessionToken } from '@/lib/gateway'
import { LogIn, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'

const BORDER = 'hsl(var(--border))'
const TEXT = 'hsl(var(--foreground))'
const MUTED = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG = 'hsl(var(--background))'
const ACCENT = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'
const OK = 'hsl(var(--status-ok))'
const DRIFT = 'hsl(var(--status-drift))'

interface LoginUrlResponse {
  url: string
  state: string
  provider: 'mock' | 'workos' | 'okta' | 'google' | 'other'
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-screen flex items-center justify-center px-4"
          style={{ background: BG, color: TEXT }}
        >
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: MUTED }} />
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  )
}

function LoginInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const returnTo = sp.get('return_to') || '/'

  const [providerInfo, setProviderInfo] = useState<LoginUrlResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Mock-only login form state. Real IdPs replace this with a redirect.
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Build login URL on mount.
  useEffect(() => {
    if (getSessionToken()) {
      // Already signed in — skip the form.
      router.replace(returnTo)
      return
    }
    (async () => {
      try {
        const redirect_uri =
          typeof window !== 'undefined'
            ? `${window.location.origin}/login/callback`
            : ''
        const res = await gw(
          `auth/login-url?redirect_uri=${encodeURIComponent(redirect_uri)}&return_to=${encodeURIComponent(returnTo)}`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as LoginUrlResponse
        setProviderInfo(data)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [router, returnTo])

  // Mock-only path: skip the IdP roundtrip and call /callback directly with
  // the email-as-code. Real IdPs would have redirected to providerInfo.url
  // and let the IdP send the browser back to /login/callback?code=...&state=...
  async function handleMockSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!providerInfo || !email.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const redirect_uri = `${window.location.origin}/login/callback`
      const cb = await gw('auth/callback', {
        method: 'POST',
        body: JSON.stringify({
          code: email.trim(),
          state: providerInfo.state,
          redirect_uri,
        }),
      })
      const data = await cb.json()
      if (!cb.ok) {
        throw new Error(data?.error?.message || data?.error || `HTTP ${cb.status}`)
      }
      setSessionToken(data.token)
      router.replace(data.return_to || returnTo)
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: BG, color: TEXT }}
    >
      <div
        className="w-full max-w-sm rounded-lg border p-6"
        style={{ background: SURFACE, borderColor: BORDER }}
      >
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="h-5 w-5" style={{ color: ACCENT }} />
          <h1 className="text-lg font-semibold" style={{ color: TEXT }}>
            Sign in to AEGIS
          </h1>
        </div>

        {loading && (
          <p
            className="text-sm inline-flex items-center gap-2"
            style={{ color: MUTED }}
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Resolving identity provider…
          </p>
        )}

        {error && (
          <div
            className="rounded-md p-3 mb-3 text-xs inline-flex items-start gap-2"
            style={{ background: BG, border: `1px solid ${BORDER}`, color: DRIFT }}
          >
            <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {providerInfo && (
          <>
            {providerInfo.provider === 'mock' ? (
              // Mock IdP — local-dev path. The email entered here becomes
              // the user's identity. No password, no IdP redirect; that's
              // the entire point of mock mode.
              <form onSubmit={handleMockSubmit} className="space-y-3">
                <div>
                  <label
                    className="text-[11px] uppercase tracking-wider block mb-1"
                    style={{ color: MUTED }}
                  >
                    Email
                  </label>
                  <input
                    type="email"
                    autoFocus
                    required
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full text-sm px-3 py-1.5 rounded-md border font-mono"
                    style={{ background: BG, borderColor: BORDER, color: TEXT }}
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting || !email.trim()}
                  className="w-full text-sm px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                  style={{ background: ACCENT, color: ON_PRIM }}
                >
                  {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LogIn className="h-3.5 w-3.5" />
                  )}
                  Sign in
                </button>
                <p className="text-[11px]" style={{ color: MUTED }}>
                  Local dev uses the mock IdP — any email signs in. Configure a
                  real provider (WorkOS / Okta / Google) in production.
                </p>
              </form>
            ) : (
              // Real IdP — single button to redirect to the provider.
              <a
                href={providerInfo.url}
                className="w-full text-sm px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5"
                style={{ background: ACCENT, color: ON_PRIM }}
              >
                <LogIn className="h-3.5 w-3.5" />
                Continue with {providerInfo.provider}
              </a>
            )}
          </>
        )}
      </div>
    </div>
  )
}
