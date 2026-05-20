'use client'

import { useEffect, useState } from 'react'
import { Shield, ShieldAlert } from 'lucide-react'
import { gw } from '@/lib/gateway'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const BG      = 'hsl(var(--background))'
const OK      = 'hsl(150 22% 38%)'   // moss, matches /welcome decision color
const ALERT   = 'hsl(0 50% 38%)'     // oxblood
const PENDING = 'hsl(36 60% 32%)'    // mustard

interface Stats {
  totalTraces: number
  pendingChecks: number
  violations24h: number
  activeAgents: number
  tracesTrend: number
}

export function StatusBar() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [reachable, setReachable] = useState(true)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await gw('stats')
        if (cancelled) return
        if (!res.ok) {
          setReachable(false)
          return
        }
        const data = await res.json()
        setStats(data)
        setReachable(true)
      } catch {
        if (!cancelled) setReachable(false)
      }
    }
    tick()
    const id = setInterval(tick, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const protectionOn = reachable && stats !== null
  const blocked = stats?.violations24h ?? 0
  const pending = stats?.pendingChecks ?? 0
  const traces  = stats?.totalTraces ?? 0
  const agents  = stats?.activeAgents ?? 0

  return (
    <div
      className="flex items-center gap-4 px-4 py-1.5 text-xs flex-wrap"
      style={{
        background: BG,
        borderBottom: `1px solid ${BORDER}`,
        color: MUTED,
      }}
    >
      <span className="inline-flex items-center gap-1.5" style={{ color: protectionOn ? OK : ALERT }}>
        {protectionOn ? (
          <Shield className="h-3.5 w-3.5" />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5" />
        )}
        <span className="font-medium">
          {protectionOn ? 'Protected' : 'Gateway unreachable'}
        </span>
      </span>

      {protectionOn && (
        <>
          <span className="opacity-50">·</span>
          <Stat label="traces" value={fmt(traces)} />

          <span className="opacity-50">·</span>
          <Stat label="agents (24h)" value={fmt(agents)} />

          <span className="opacity-50">·</span>
          <Stat
            label="blocked (24h)"
            value={fmt(blocked)}
            tint={blocked > 0 ? ALERT : MUTED}
          />

          {pending > 0 && (
            <>
              <span className="opacity-50">·</span>
              <Stat
                label="pending"
                value={fmt(pending)}
                tint={PENDING}
              />
            </>
          )}
        </>
      )}

      <span className="opacity-50 ml-auto hidden sm:inline">·</span>
      <span className="hidden sm:inline" style={{ color: MUTED, opacity: 0.7 }}>
        live · refresh 10s
      </span>
    </div>
  )
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span style={{ color: tint ?? TEXT, fontFeatureSettings: '"tnum"' }} className="font-medium">
        {value}
      </span>
      <span style={{ color: MUTED }}>{label}</span>
    </span>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}
