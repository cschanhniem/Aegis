import Link from 'next/link'

export default function Home() {
  return (
    <div className="shell">
      <span className="brand">AEGIS</span>
      <h1>Hosted AEGIS.</h1>
      <p className="lede">
        Every tool call your agent makes — classified, gated, audited. No
        infra to run; just point your SDK and watch.
      </p>
      <div className="form-stack">
        <Link href="/signup"><button style={{ width: '100%' }}>Create an org</button></Link>
        <Link href="/login"><button className="ghost" style={{ width: '100%' }}>Sign in</button></Link>
      </div>
      <p className="meta">
        Prefer to self-host? <a href="https://github.com/Justin0504/Aegis">Open source on GitHub</a>.
      </p>
    </div>
  )
}
