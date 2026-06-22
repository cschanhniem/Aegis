'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface ProvisionedTenant {
  orgId: string
  slug: string
  apiKey: string
  apiKeyPrefix: string
}

export default function WelcomePage() {
  const [tenant, setTenant] = useState<ProvisionedTenant | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const raw = sessionStorage.getItem('aegis.newkey')
    if (!raw) return
    try { setTenant(JSON.parse(raw)) } catch {}
    // Belt and suspenders — keep until copied, then clear.
  }, [])

  const cockpitUrl = tenant ? `https://${tenant.slug}.aegis.dev` : ''

  function copyKey() {
    if (!tenant) return
    navigator.clipboard.writeText(tenant.apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  function done() {
    sessionStorage.removeItem('aegis.newkey')
    window.location.href = cockpitUrl
  }

  if (!tenant) {
    return (
      <div className="shell">
        <span className="brand">AEGIS</span>
        <h1>No fresh key.</h1>
        <p className="lede">
          The signup key is shown exactly once and lives in your browser's
          session storage. If you closed the tab, generate a new key from
          the cockpit settings page.
        </p>
        <Link href="/login"><button>Sign in</button></Link>
      </div>
    )
  }

  return (
    <div className="shell" style={{ maxWidth: 560 }}>
      <span className="brand">AEGIS</span>
      <h1>Org provisioned.</h1>
      <p className="lede">
        Your gateway is at <code>{cockpitUrl.replace('https://', 'gw.')}</code>.
        Below is your API key — <b>this is the only time you'll see it.</b>
      </p>

      <div className="card form-stack">
        <div>
          <label>API key</label>
          <div className="code">{tenant.apiKey}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button type="button" onClick={copyKey} style={{ flex: 1 }}>
            {copied ? 'Copied ✓' : 'Copy key'}
          </button>
          <button type="button" className="ghost" onClick={done} style={{ flex: 1 }}>
            Open my cockpit →
          </button>
        </div>

        <div className="divider">Use it in 5 seconds</div>

        <div>
          <label>Python</label>
          <pre className="code">{`pip install agentguard-aegis

import agentguard
agentguard.auto(
  gateway="https://gw.aegis.dev",
  api_key="${tenant.apiKey.slice(0, 12)}…",
)`}</pre>
        </div>

        <div>
          <label>JS / TypeScript</label>
          <pre className="code">{`npm i @justinnn/agentguard

import { autowrap } from '@justinnn/agentguard'
autowrap({
  gateway: 'https://gw.aegis.dev',
  apiKey: '${tenant.apiKey.slice(0, 12)}…',
})`}</pre>
        </div>
      </div>

      <p className="meta">
        Lost the key? It's gone — but you can rotate from
        cockpit → Settings → API keys.
      </p>
    </div>
  )
}
