'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface OrgRow {
  id: string
  slug: string
  display_name: string
  plan: 'free' | 'pro' | 'team' | 'enterprise'
  monthly_check_quota: number
  retention_days: number
}

export default function DashboardPage() {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/me')
      .then(async r => {
        if (!r.ok) throw new Error('not signed in')
        return r.json()
      })
      .then(d => setOrgs(d.orgs ?? []))
      .catch(e => setError(e.message))
  }, [])

  if (error) {
    return (
      <div className="shell">
        <span className="brand">AEGIS</span>
        <h1>Sign in.</h1>
        <p className="lede">You're not signed in.</p>
        <Link href="/login"><button>Sign in</button></Link>
      </div>
    )
  }

  if (!orgs) return <div className="shell"><p className="lede">Loading…</p></div>

  return (
    <div className="shell" style={{ maxWidth: 640 }}>
      <Link href="/" className="brand">AEGIS</Link>
      <h1>Your orgs.</h1>
      <p className="lede">Pick one to open the cockpit.</p>

      <div className="form-stack">
        {orgs.length === 0 ? (
          <div className="card">
            <p>No orgs yet.</p>
            <Link href="/signup"><button style={{ width: '100%' }}>Create an org</button></Link>
          </div>
        ) : orgs.map(o => (
          <div key={o.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{o.display_name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                <code>{o.slug}.aegis.dev</code> · {o.plan.toUpperCase()} · {o.monthly_check_quota.toLocaleString()} checks/mo · {o.retention_days}d retention
              </div>
            </div>
            <a href={`https://${o.slug}.aegis.dev`}>
              <button style={{ whiteSpace: 'nowrap' }}>Open cockpit →</button>
            </a>
          </div>
        ))}

        <Link href="/billing" style={{ marginTop: '1rem' }}>
          <button className="ghost" style={{ width: '100%' }}>View pricing & billing →</button>
        </Link>
      </div>
    </div>
  )
}
