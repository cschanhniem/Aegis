'use client'

import { useState } from 'react'
import { gw } from '@/lib/gateway'
import { ShieldCheck, ShieldAlert, Loader2, KeyRound } from 'lucide-react'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const ACCENT  = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'
const OK      = 'hsl(var(--status-ok))'
const DRIFT   = 'hsl(var(--status-drift))'

interface IntegrityReport {
  ok: boolean
  agent_id: string
  total: number
  latest_trace_id: string | null
  latency_ms: number
  broken_at?: {
    reason: string
    sequence_number: number
    trace_id: string
    expected: string
    actual: string
  }
}

interface Props {
  /** Optional initial agent_id (e.g. from a row's resource_id click). */
  initialAgentId?: string
  /** When the parent wants to control the input externally. */
  onAgentIdChange?: (id: string) => void
}

export function IntegrityWidget({ initialAgentId = '', onAgentIdChange }: Props) {
  const [agentId, setAgentId] = useState<string>(initialAgentId)
  const [report, setReport] = useState<IntegrityReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)

  function setId(id: string) {
    setAgentId(id)
    setReport(null)
    setError(null)
    onAgentIdChange?.(id)
  }

  async function verify() {
    const id = agentId.trim()
    if (!id) return
    setVerifying(true)
    setError(null)
    setReport(null)
    try {
      const res = await gw(`integrity/verify?agent_id=${encodeURIComponent(id)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setReport(data as IntegrityReport)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div
      className="rounded-md p-3"
      style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
    >
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <label
            className="text-[10px] uppercase tracking-wider block mb-1 inline-flex items-center gap-1.5"
            style={{ color: MUTED }}
          >
            <KeyRound className="h-3 w-3" /> Verify chain integrity
          </label>
          <input
            value={agentId}
            onChange={(e) => setId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && verify()}
            placeholder="agent_id (UUID)…"
            className="w-full text-sm px-2 py-1.5 rounded-md border font-mono"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          />
        </div>
        <button
          onClick={verify}
          disabled={verifying || !agentId.trim()}
          className="text-sm px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40"
          style={{ background: ACCENT, color: ON_PRIM }}
        >
          {verifying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          Verify
        </button>
      </div>

      {error && (
        <div className="mt-2 text-xs" style={{ color: DRIFT }}>
          {error}
        </div>
      )}

      {report && (
        <div className="mt-3 text-xs space-y-1">
          {report.ok ? (
            <div className="inline-flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" style={{ color: OK }} />
              <span style={{ color: OK, fontWeight: 500 }}>Chain intact</span>
              <span style={{ color: MUTED }}>
                · {report.total} trace{report.total === 1 ? '' : 's'}
                {report.latest_trace_id && (
                  <>
                    {' · latest '}
                    <code className="font-mono" style={{ color: TEXT }}>
                      {report.latest_trace_id.slice(0, 8)}…
                    </code>
                  </>
                )}
                {' · '}
                {report.latency_ms}ms
              </span>
            </div>
          ) : (
            <>
              <div className="inline-flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" style={{ color: DRIFT }} />
                <span style={{ color: DRIFT, fontWeight: 500 }}>Chain broken</span>
                <span style={{ color: MUTED }}>
                  · {report.total} trace{report.total === 1 ? '' : 's'} ·{' '}
                  {report.latency_ms}ms
                </span>
              </div>
              {report.broken_at && (
                <div
                  className="rounded-md p-2 mt-1"
                  style={{ background: BG, border: `1px solid ${BORDER}` }}
                >
                  <div style={{ color: TEXT }}>
                    Break at sequence{' '}
                    <span className="font-mono" style={{ color: DRIFT }}>
                      {report.broken_at.sequence_number}
                    </span>{' '}
                    · trace{' '}
                    <span className="font-mono" style={{ color: TEXT }}>
                      {report.broken_at.trace_id}
                    </span>
                  </div>
                  <div style={{ color: MUTED }} className="mt-1">
                    reason:{' '}
                    <span className="font-mono" style={{ color: DRIFT }}>
                      {report.broken_at.reason}
                    </span>
                  </div>
                  <div style={{ color: MUTED }} className="mt-1 font-mono break-all">
                    expected: {report.broken_at.expected}
                  </div>
                  <div style={{ color: MUTED }} className="font-mono break-all">
                    actual:&nbsp;&nbsp; {report.broken_at.actual}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
