'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'invalid email or password')
      router.push('/dashboard')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shell">
      <Link href="/" className="brand">AEGIS</Link>
      <h1>Welcome back.</h1>
      <p className="lede">Sign in to your AEGIS org.</p>

      <form onSubmit={submit} className="card form-stack">
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required
                 value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required
                 value={password} onChange={e => setPassword(e.target.value)} />
        </div>

        {error && <div className="error">{error}</div>}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="meta">
        New here? <Link href="/signup">Create an org</Link>
      </p>
    </div>
  )
}
