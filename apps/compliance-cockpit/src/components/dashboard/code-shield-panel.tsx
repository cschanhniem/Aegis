'use client'

import { useQuery } from '@tanstack/react-query'
import { FileCode2, AlertOctagon, AlertTriangle, ShieldCheck, Clock } from 'lucide-react'
import { gw } from '@/lib/gateway'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'

// Severity → palette. Same hues as the alignment panel for visual
// consistency: oxblood for critical, mustard for medium/high, moss
// for the (uncommon) LOW-only band.
const SEV_COLOR: Record<string, string> = {
  CRITICAL: 'hsl(0 50% 38%)',
  HIGH:     'hsl(12 55% 35%)',
  MEDIUM:   'hsl(36 60% 32%)',
  LOW:      'hsl(150 22% 32%)',
}

interface CodeShieldItem {
  id: number
  agent_id: string | null
  created_at: string
  worst: string | null
  findings_count: number
  rules: string[]
  user_email: string | null
}

function relative(time: string): string {
  const t = new Date(time + 'Z')
  const ms = Date.now() - t.getTime()
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function Icon({ worst }: { worst: string | null }) {
  if (worst === 'CRITICAL' || worst === 'HIGH') {
    return <AlertOctagon className="h-4 w-4 flex-shrink-0" style={{ color: SEV_COLOR[worst] }} />
  }
  if (worst === 'MEDIUM') {
    return <AlertTriangle className="h-4 w-4 flex-shrink-0" style={{ color: SEV_COLOR[worst] }} />
  }
  if (worst === 'LOW') {
    return <ShieldCheck className="h-4 w-4 flex-shrink-0" style={{ color: SEV_COLOR[worst] }} />
  }
  return <FileCode2 className="h-4 w-4 flex-shrink-0" style={{ color: MUTED }} />
}

export function CodeShieldPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['code-shield-recent'],
    queryFn: async () => {
      const res = await gw('code-shield/recent?limit=30')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { items: CodeShieldItem[] }
    },
    refetchInterval: 15_000,
  })

  const items = data?.items ?? []

  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-lg font-medium" style={{ color: TEXT }}>
          Code Shield
        </h2>
        <p className="text-sm" style={{ color: MUTED }}>
          Fast local regex scans of agent-generated code — picks up
          eval/exec, hard-coded secrets, destructive shell, and dangerous
          SQL before the agent runs them. Sub-millisecond per scan.{' '}
          <a
            href="https://github.com/Justin0504/Aegis/blob/main/ROADMAP.md"
            target="_blank"
            rel="noopener"
            className="underline"
            style={{ color: MUTED }}
          >
            See ROADMAP →
          </a>
        </p>
      </header>

      {isLoading && (
        <p className="text-xs" style={{ color: MUTED }}>Loading…</p>
      )}

      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: SEV_COLOR.CRITICAL }}
        >
          Could not load code-shield findings: {(error as Error).message}.
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div
          className="rounded-md p-6 text-center"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
        >
          <p className="text-sm" style={{ color: TEXT }}>
            No code-shield findings yet.
          </p>
          <p className="text-xs mt-1.5" style={{ color: MUTED }}>
            Agents that generate code can call{' '}
            <code className="font-mono">POST /api/v1/code-shield/scan</code>{' '}
            with a snippet. The worst severity also flows into the
            Policy DSL — try rules like{' '}
            <code className="font-mono">{'{ code_shield.worst: CRITICAL }'}</code>.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it) => {
            const sevColor = it.worst ? SEV_COLOR[it.worst] ?? MUTED : MUTED
            return (
              <li
                key={it.id}
                className="rounded-md p-3"
                style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
              >
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon worst={it.worst} />
                    <span
                      className="font-mono text-xs truncate"
                      style={{ color: TEXT }}
                      title={it.agent_id ?? '(unknown)'}
                    >
                      {it.agent_id ?? '(unknown agent)'}
                    </span>
                    {it.worst && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
                        style={{ background: BG, color: sevColor, border: `1px solid ${sevColor}` }}
                      >
                        {it.worst}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className="font-mono text-sm tabular-nums"
                      style={{ color: sevColor }}
                    >
                      {it.findings_count}
                    </span>
                    <span
                      className="text-[11px] inline-flex items-center gap-1"
                      style={{ color: MUTED }}
                    >
                      <Clock className="h-3 w-3" />
                      {relative(it.created_at)}
                    </span>
                  </div>
                </div>

                {it.rules.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {it.rules.slice(0, 8).map((r, i) => (
                      <span
                        key={i}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                        style={{
                          background: BG,
                          color: sevColor,
                          border: `1px solid ${BORDER}`,
                        }}
                      >
                        {r}
                      </span>
                    ))}
                    {it.rules.length > 8 && (
                      <span className="text-[10px]" style={{ color: MUTED }}>
                        +{it.rules.length - 8} more
                      </span>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
