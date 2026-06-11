'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { gw } from '@/lib/gateway'

const ONBOARDED_KEY = 'aegis:onboarded'

/**
 * Renders nothing. On mount, checks whether this looks like a brand-new
 * tenant (no agents on record + the local "we've already done this"
 * flag unset). If so, redirects to /onboarding.
 *
 * Routes that already are onboarding flows (/onboarding, /welcome,
 * /login, /api) opt out so we don't bounce the user in circles.
 */
export function FirstRunGuard() {
  const router   = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!pathname) return
    if (pathname.startsWith('/onboarding')) return
    if (pathname.startsWith('/welcome'))    return
    if (pathname.startsWith('/login'))      return
    try {
      if (localStorage.getItem(ONBOARDED_KEY) === '1') return
    } catch { /* localStorage unavailable */ return }

    let cancelled = false
    ;(async () => {
      try {
        const r = await gw('onboarding/status')
        if (cancelled) return
        if (r.ok) {
          const status = await r.json()
          if (status?.has_agents) {
            try { localStorage.setItem(ONBOARDED_KEY, '1') } catch {}
            return
          }
          // No agents on record — first run.
          router.replace('/onboarding')
        }
      } catch { /* gateway unreachable; stay put */ }
    })()
    return () => { cancelled = true }
  }, [pathname, router])

  return null
}
