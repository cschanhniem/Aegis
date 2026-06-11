'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Check, ArrowRight, ArrowLeft, ShieldCheck, AlertCircle, Wifi, WifiOff } from 'lucide-react'
import { useOnboardingStream } from '@/hooks/useOnboardingStream'
import { gw } from '@/lib/gateway'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const PRIMARY = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'

export interface FirstSightingEvent {
  orgId: string
  agentId: string
  timestamp: string
  provenance?: { build_artifact?: string; source_commit?: string }
}

export function LiveWaiting(props: {
  firstAgent: FirstSightingEvent | null
  onFirstSighting: (e: FirstSightingEvent) => void
  onFinish: () => void
  onBack: () => void
}) {
  const { firstAgent, onFirstSighting, onFinish, onBack } = props
  const { events, connectionState } = useOnboardingStream({ enabled: true })

  useEffect(() => {
    if (firstAgent) return
    const e = events.find(ev => ev.event === 'agent.first_sighting')
    if (e) onFirstSighting(e.data as FirstSightingEvent)
  }, [events, firstAgent, onFirstSighting])

  // Also accept events fired before the stream connected — the gateway
  // sends a `snapshot` event listing any agents already registered.
  useEffect(() => {
    if (firstAgent) return
    const snap = events.find(ev => ev.event === 'snapshot')
    if (snap && Array.isArray(snap.data?.agents) && snap.data.agents.length > 0) {
      const a = snap.data.agents[0]
      onFirstSighting({
        orgId: 'default',
        agentId: a.id,
        timestamp: a.last_seen_at ?? new Date().toISOString(),
      })
    }
  }, [events, firstAgent, onFirstSighting])

  if (firstAgent) {
    return <Celebration agent={firstAgent} onFinish={onFinish} onBack={onBack} />
  }

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1
          className="text-2xl md:text-3xl leading-tight"
          style={{ fontFamily: 'var(--font-serif), ui-serif, Georgia, serif', color: TEXT, letterSpacing: '-0.012em' }}
        >
          Waiting for your first agent…
        </h1>
        <p className="text-sm max-w-2xl" style={{ color: MUTED }}>
          Run your agent or the demo. The moment the gateway sees a tool call, this screen will flip to a confirmation and offer to register it.
        </p>
      </header>

      <div
        className="rounded-md p-5 flex items-center gap-4"
        style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
      >
        <span className="relative inline-flex h-3 w-3 flex-shrink-0">
          <span
            className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
            style={{ background: PRIMARY }}
          />
          <span
            className="relative inline-flex rounded-full h-3 w-3"
            style={{ background: PRIMARY }}
          />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm" style={{ color: TEXT }}>Listening for the first tool call…</p>
          <p className="text-[11px] mt-0.5 font-mono inline-flex items-center gap-1" style={{ color: MUTED }}>
            {connectionState === 'open' ? (
              <><Wifi className="h-3 w-3" /> SSE stream live</>
            ) : connectionState === 'reconnecting' ? (
              <><WifiOff className="h-3 w-3" /> reconnecting…</>
            ) : connectionState === 'opening' ? (
              <><Loader2 className="h-3 w-3 animate-spin" /> opening stream</>
            ) : (
              <>{connectionState}</>
            )}
          </p>
        </div>
      </div>

      <div
        className="rounded-md p-4 text-xs"
        style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: MUTED }}
      >
        <p className="mb-2" style={{ color: TEXT }}>Common things to check while you wait:</p>
        <ul className="space-y-1 list-disc pl-5">
          <li>Is the gateway running on the URL you pasted into the snippet?</li>
          <li>If you copied the Python or JS snippet, did the install command finish without errors?</li>
          <li>Firewalls / corporate proxies: outbound HTTP to <span className="font-mono">localhost:8080</span> needs to work.</li>
          <li>
            Stuck? Click <span className="font-mono">Back</span> to recopy the snippet, or
            try the <span className="font-mono">--demo</span> path on step 1 — it works without any LLM keys.
          </li>
        </ul>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm inline-flex items-center gap-1.5" style={{ color: MUTED }}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onFinish}
          className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
          style={{ background: SURFACE, color: TEXT, borderColor: BORDER }}
        >
          I'll wire it up later <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  )
}

function Celebration({
  agent, onFinish, onBack,
}: { agent: FirstSightingEvent; onFinish: () => void; onBack: () => void }) {
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAgent, setSavedAgent] = useState<{ id: string; name?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const register = async () => {
    setSaving(true)
    setError(null)
    try {
      const body = {
        id: agent.agentId,
        name: name.trim() || undefined,
        owner_email: owner.trim() || undefined,
      }
      const res = await gw('agents', { method: 'POST', body: JSON.stringify(body) })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error?.message || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setSavedAgent({ id: data?.agent?.id ?? agent.agentId, name: data?.agent?.name })
    } catch (e: any) {
      setError(e?.message ?? 'failed to register')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-widest" style={{ color: PRIMARY }}>
          <ShieldCheck className="inline h-3 w-3 mr-1 -mt-0.5" /> First agent detected
        </p>
        <h1
          className="text-2xl md:text-3xl leading-tight"
          style={{ fontFamily: 'var(--font-serif), ui-serif, Georgia, serif', color: TEXT, letterSpacing: '-0.012em' }}
        >
          You're <em style={{ fontStyle: 'italic' }}>under guard</em>.
        </h1>
        <p className="text-sm max-w-2xl" style={{ color: MUTED }}>
          AEGIS just saw the first tool call from <span className="font-mono">{agent.agentId}</span>.
          Give it a friendly name (and an email if you want one shown on audit rows), or skip and head to the dashboard.
        </p>
      </header>

      <div className="rounded-md p-4" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
        <dl className="grid grid-cols-3 gap-y-2 text-xs">
          <dt style={{ color: MUTED }}>Agent ID</dt>
          <dd className="col-span-2 font-mono" style={{ color: TEXT }}>{agent.agentId}</dd>
          <dt style={{ color: MUTED }}>First seen</dt>
          <dd className="col-span-2 font-mono" style={{ color: TEXT }}>{agent.timestamp}</dd>
          {agent.provenance?.source_commit && (
            <>
              <dt style={{ color: MUTED }}>Source commit</dt>
              <dd className="col-span-2 font-mono" style={{ color: TEXT }}>{agent.provenance.source_commit}</dd>
            </>
          )}
          {agent.provenance?.build_artifact && (
            <>
              <dt style={{ color: MUTED }}>Build artifact</dt>
              <dd className="col-span-2 font-mono" style={{ color: TEXT }}>{agent.provenance.build_artifact}</dd>
            </>
          )}
        </dl>
      </div>

      {savedAgent ? (
        <div
          className="rounded-md p-4 text-sm inline-flex items-center gap-3"
          style={{ background: SURFACE, border: `1px solid ${PRIMARY}`, color: TEXT }}
        >
          <Check className="h-4 w-4" style={{ color: PRIMARY }} />
          <span>
            Registered <span className="font-mono">{savedAgent.id}</span>
            {savedAgent.name && <> as <span className="font-mono">{savedAgent.name}</span></>}.
          </span>
        </div>
      ) : (
        <div className="rounded-md p-4 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <h3 className="text-sm" style={{ color: TEXT }}>Register this agent (optional)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-xs space-y-1" style={{ color: MUTED }}>
              <span>Friendly name</span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="research-assistant"
                className="block w-full font-mono text-xs px-2 py-1.5 rounded outline-none"
                style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
              />
            </label>
            <label className="text-xs space-y-1" style={{ color: MUTED }}>
              <span>Owner email</span>
              <input
                value={owner}
                onChange={e => setOwner(e.target.value)}
                placeholder="you@example.com (optional)"
                className="block w-full font-mono text-xs px-2 py-1.5 rounded outline-none"
                style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
              />
            </label>
          </div>
          {error && (
            <p className="text-xs inline-flex items-center gap-1" style={{ color: 'hsl(0 60% 45%)' }}>
              <AlertCircle className="h-3 w-3" /> {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={register}
              disabled={saving}
              className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
              style={{
                background: saving ? SURFACE : PRIMARY,
                color: saving ? MUTED : ON_PRIM,
                borderColor: PRIMARY,
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Registering…</> : <>Register</>}
            </button>
            <span className="text-xs" style={{ color: MUTED }}>or skip — auto-recorded as <span className="font-mono">unregistered</span> already.</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm inline-flex items-center gap-1.5" style={{ color: MUTED }}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onFinish}
          className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
          style={{ background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY }}
        >
          Open dashboard <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  )
}
