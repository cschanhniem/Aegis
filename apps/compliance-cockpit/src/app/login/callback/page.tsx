'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { gw, setSessionToken } from '@/lib/gateway'
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'

const BORDER = 'hsl(var(--border))'
const TEXT = 'hsl(var(--foreground))'
const MUTED = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG = 'hsl(var(--background))'
const OK = 'hsl(var(--status-ok))'
const DRIFT = 'hsl(var(--status-drift))'

/**
 * IdP callback landing — browser arrives here from the real IdP with
 * ?code=…&state=… (mock IdP doesn't go through this path; it POSTs from
 * the form on /login directly). Exchanges code for a session token via
 * the gateway and routes the user to their intended page.
 */
export default function CallbackPage() {
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
      <CallbackInner />
    </Suspense>
  )
}

function CallbackInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const code = sp.get('code')
    const state = sp.get('state')
    if (!code || !state) {
      setError('Missing code or state on callback URL.')
      return
    }
    (async () => {
      try {
        const redirect_uri = `${window.location.origin}/login/callback`
        const res = await gw('auth/callback', {
          method: 'POST',
          body: JSON.stringify({ code, state, redirect_uri }),
        })
        const data = await res.json()
        if (!res.ok) {
          throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`)
        }
        setSessionToken(data.token)
        router.replace(data.return_to || '/')
      } catch (e) {
        setError((e as Error).message)
      }
    })()
  }, [sp, router])

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: BG, color: TEXT }}
    >
      <div
        className="w-full max-w-sm rounded-lg border p-6 text-center"
        style={{ background: SURFACE, borderColor: BORDER }}
      >
        {error ? (
          <>
            <ShieldAlert
              className="h-7 w-7 mx-auto mb-2"
              style={{ color: DRIFT }}
            />
            <p className="text-sm" style={{ color: TEXT }}>
              Login failed
            </p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              {error}
            </p>
            <a
              href="/login"
              className="text-xs mt-3 inline-block underline"
              style={{ color: MUTED }}
            >
              Try again →
            </a>
          </>
        ) : (
          <>
            <Loader2
              className="h-7 w-7 mx-auto mb-2 animate-spin"
              style={{ color: MUTED }}
            />
            <p className="text-sm" style={{ color: TEXT }}>
              Finishing login…
            </p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              Exchanging code for a session token.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
