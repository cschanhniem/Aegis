'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { gw, getSessionToken, clearSessionToken } from '@/lib/gateway'
import { LogIn, LogOut, UserRound, Loader2 } from 'lucide-react'

const BORDER = 'hsl(var(--border))'
const TEXT   = 'hsl(var(--foreground))'
const MUTED  = 'hsl(var(--muted-foreground))'
const OK     = 'hsl(var(--status-ok))'

interface MeUser {
  id: string
  email: string
  name?: string
  role: string
  provider: string
}

/**
 * Sidebar account widget. Three states:
 *   loading    — first paint, /auth/me still in flight
 *   signed-in  — show email + role + sign-out button
 *   signed-out — show "Sign in" link (no hard redirect — the Cockpit
 *                also works via API key, so SSO is opt-in)
 */
export function AccountWidget() {
  const router = useRouter()
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading')
  const [user, setUser]   = useState<MeUser | null>(null)
  const [busy, setBusy]   = useState(false)

  useEffect(() => {
    if (!getSessionToken()) {
      setState('out')
      return
    }
    (async () => {
      try {
        const res = await gw('auth/me')
        if (res.ok) {
          const data = await res.json()
          setUser(data.user)
          setState('in')
        } else {
          clearSessionToken()
          setState('out')
        }
      } catch {
        // Network blip — assume signed-out rather than hang the sidebar.
        setState('out')
      }
    })()
  }, [])

  async function handleSignOut() {
    setBusy(true)
    try {
      await gw('auth/logout', { method: 'POST' })
    } catch {
      // Even if the server call fails, we want the browser-side token
      // gone — the gateway will reject it on next use anyway.
    }
    clearSessionToken()
    setUser(null)
    setState('out')
    setBusy(false)
    router.push('/login')
  }

  if (state === 'loading') {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 rounded-md"
        style={{ color: MUTED }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-[11px]">Loading account…</span>
      </div>
    )
  }

  if (state === 'out') {
    return (
      <Link
        href="/login"
        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-opacity hover:opacity-70"
        style={{ background: 'transparent', border: '1px solid hsl(var(--border))', color: MUTED }}
      >
        <LogIn className="h-3 w-3" />
        <span>Sign in</span>
        <span className="ml-auto" style={{ color: MUTED, opacity: 0.7 }}>
          for audit
        </span>
      </Link>
    )
  }

  return (
    <div className="space-y-1.5">
      <div
        className="flex items-center gap-2 px-2 py-1"
        style={{ color: TEXT }}
      >
        <UserRound className="h-3 w-3" style={{ color: OK }} />
        <span className="text-[11px] truncate" title={user?.email}>
          {user?.email}
        </span>
      </div>
      <button
        onClick={handleSignOut}
        disabled={busy}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-opacity hover:opacity-70 disabled:opacity-40"
        style={{ background: 'transparent', border: '1px solid hsl(var(--border))', color: MUTED }}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <LogOut className="h-3 w-3" />
        )}
        <span>Sign out</span>
        <span className="ml-auto capitalize" style={{ color: MUTED, opacity: 0.7 }}>
          {user?.role}
        </span>
      </button>
    </div>
  )
}
