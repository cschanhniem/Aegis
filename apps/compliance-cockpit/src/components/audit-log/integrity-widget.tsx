'use client'

import { useState } from 'react'
import { gw } from '@/lib/gateway'
import { ShieldCheck, ShieldAlert, Loader2, KeyRound, ListChecks } from 'lucide-react'

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

interface BulkReport {
  total_agents: number
  ok_agents: number
  broken_agents: number
  agents: Array<{
    agent_id: string
    ok: boolean
    total: number
    broken_at?: {
      reason: string
      sequence_number: number
      trace_id: string
    }
  }>
  latency_ms: number
}

export function IntegrityWidget({ initialAgentId = '', onAgentIdChange }: Props) {
  const [agentId, setAgentId] = useState<string>(initialAgentId)
  const [report, setReport] = useState<IntegrityReport | null>(null)
  const [bulk, setBulk] = useState<BulkReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [bulkVerifying, setBulkVerifying] = useState(false)

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
    setBulk(null)
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

  async function verifyAll() {
    setBulkVerifying(true)
    setError(null)
    setReport(null)
    setBulk(null)
    try {
      const res = await gw('integrity/verify-all')
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setBulk(data as BulkReport)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBulkVerifying(false)
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
          disabled={verifying || bulkVerifying || !agentId.trim()}
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
        <button
          onClick={verifyAll}
          disabled={verifying || bulkVerifying}
          className="text-sm px-3 py-1.5 rounded-md border inline-flex items-center gap-1.5 disabled:opacity-40"
          style={{ background: BG, borderColor: BORDER, color: TEXT }}
          title="Verify every agent's chain in one sweep"
        >
          {bulkVerifying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ListChecks className="h-3.5 w-3.5" />
          )}
          Verify all
        </button>
      </div>

      {error && (
        <div className="mt-2 text-xs" style={{ color: DRIFT }}>
          {error}
        </div>
      )}

      {bulk && (
        <div className="mt-3 text-xs space-y-2">
          <div className="inline-flex items-center gap-2">
            {bulk.broken_agents === 0 ? (
              <>
                <ShieldCheck className="h-4 w-4" style={{ color: OK }} />
                <span style={{ color: OK, fontWeight: 500 }}>
                  All {bulk.total_agents} chain{bulk.total_agents === 1 ? '' : 's'} intact
                </span>
              </>
            ) : (
              <>
                <ShieldAlert className="h-4 w-4" style={{ color: DRIFT }} />
                <span style={{ color: DRIFT, fontWeight: 500 }}>
                  {bulk.broken_agents} of {bulk.total_agents} chain{bulk.total_agents === 1 ? '' : 's'} broken
                </span>
              </>
            )}
            <span style={{ color: MUTED }}>· {bulk.latency_ms}ms</span>
          </div>

          {bulk.agents.length > 0 && (
            <table className="w-full text-[11px]" style={{ borderTop: `1px solid ${BORDER}` }}>
              <tbody>
                {bulk.agents.map((a) => (
                  <tr key={a.agent_id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td className="px-1 py-1 align-top w-4">
                      {a.ok ? (
                        <ShieldCheck className="h-3 w-3" style={{ color: OK }} />
                      ) : (
                        <ShieldAlert className="h-3 w-3" style={{ color: DRIFT }} />
                      )}
                    </td>
                    <td className="px-1 py-1 align-top">
                      <button
                        type="button"
                        onClick={() => setId(a.agent_id)}
                        className="font-mono underline decoration-dotted underline-offset-2"
                        style={{ color: TEXT, background: 'transparent', cursor: 'pointer' }}
                        title="Drop this agent_id into the input above"
                      >
                        {a.agent_id.length > 24 ? a.agent_id.slice(0, 8) + '…' : a.agent_id}
                      </button>
                    </td>
                    <td className="px-1 py-1 align-top tabular-nums" style={{ color: MUTED }}>
                      {a.total} trace{a.total === 1 ? '' : 's'}
                    </td>
                    <td className="px-1 py-1 align-top" style={{ color: a.ok ? MUTED : DRIFT }}>
                      {a.ok ? 'ok' : `${a.broken_at?.reason} @ seq ${a.broken_at?.sequence_number}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
