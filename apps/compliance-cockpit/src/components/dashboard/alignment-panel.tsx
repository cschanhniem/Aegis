'use client'

import { useQuery } from '@tanstack/react-query'
import { ShieldAlert, ShieldCheck, Clock } from 'lucide-react'
import { gw } from '@/lib/gateway'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const OK      = 'hsl(var(--status-ok))'
const DRIFTED = 'hsl(var(--status-drift))'
const ATTN    = 'hsl(var(--status-attn))'

interface AlignmentItem {
  id: number
  agent_id: string | null
  created_at: string
  score: number | null
  drifted: boolean
  signals: string[]
  model: string | null
  reason: string | null
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

function tint(score: number | null, drifted: boolean): string {
  if (score === null) return MUTED
  if (drifted) return DRIFTED
  if (score >= 0.85) return OK
  if (score >= 0.5) return ATTN
  return DRIFTED
}

/**
 * Short band label so users glancing at a 0.62 don't have to
 * remember the thresholds. Three bands: aligned / attention /
 * drift. Drifted=true short-circuits everything to "drift" even
 * if the numeric score is high — the boolean is the auditor's
 * explicit verdict and outranks the score on its own.
 */
function bandLabel(score: number | null, drifted: boolean): string {
  if (score === null) return '—'
  if (drifted) return 'drift'
  if (score >= 0.85) return 'aligned'
  if (score >= 0.5) return 'attention'
  return 'drift'
}

export function AlignmentPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['alignment-recent'],
    queryFn: async () => {
      const res = await gw('alignment/recent?limit=30')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { items: AlignmentItem[] }
    },
    refetchInterval: 15_000,
  })

  const items = data?.items ?? []

  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-lg font-medium" style={{ color: TEXT }}>
          Agent alignment
        </h2>
        <p className="text-sm" style={{ color: MUTED }}>
          Recent alignment audits — does the proposed tool call serve the
          agent's declared goal, or has the agent drifted?{' '}
          <a
            href="https://github.com/Justin0504/Aegis/blob/main/ROADMAP.md#v03"
            target="_blank"
            rel="noopener"
            className="underline"
            style={{ color: MUTED }}
          >
            See ROADMAP v0.3 →
          </a>
        </p>
      </header>

      {isLoading && (
        <p className="text-xs" style={{ color: MUTED }}>Loading…</p>
      )}

      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: DRIFTED }}
        >
          Could not load alignment audits: {(error as Error).message}.
          The endpoint requires the <code>judge</code> feature; check that
          your gateway has an LLM provider configured.
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div
          className="rounded-md p-6 text-center"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
        >
          <p className="text-sm" style={{ color: TEXT }}>
            No alignment audits yet.
          </p>
          <p className="text-xs mt-1.5" style={{ color: MUTED }}>
            SDKs that capture chain-of-thought (LangChain, CrewAI) can call{' '}
            <code className="font-mono">POST /api/v1/alignment/check</code> to
            log a verdict here. The score also flows into the Policy DSL —
            you can write rules like{' '}
            <code className="font-mono">{'{ alignment.drifted: true }'}</code>.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="rounded-md p-3"
              style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
            >
              <div className="flex items-center justify-between gap-3 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  {it.drifted ? (
                    <ShieldAlert className="h-4 w-4 flex-shrink-0" style={{ color: DRIFTED }} />
                  ) : (
                    <ShieldCheck className="h-4 w-4 flex-shrink-0" style={{ color: OK }} />
                  )}
                  <span
                    className="font-mono text-xs truncate"
                    style={{ color: TEXT }}
                    title={it.agent_id ?? '(unknown)'}
                  >
                    {it.agent_id ?? '(unknown agent)'}
                  </span>
                  {it.model && (
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                      style={{ background: BG, color: MUTED }}
                    >
                      {it.model}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span
                    className="font-mono text-sm tabular-nums"
                    style={{ color: tint(it.score, it.drifted) }}
                  >
                    {it.score !== null ? it.score.toFixed(2) : '—'}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-wider"
                    style={{ color: tint(it.score, it.drifted), opacity: 0.85 }}
                  >
                    {bandLabel(it.score, it.drifted)}
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

              {it.signals.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {it.signals.map((s, i) => (
                    <span
                      key={i}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        background: BG,
                        color: DRIFTED,
                        border: `1px solid ${BORDER}`,
                      }}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}

              {it.reason && (
                <p className="text-xs mt-1.5 leading-snug" style={{ color: MUTED }}>
                  {it.reason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
