'use client'

import { useState } from 'react'
import { gw } from '@/lib/gateway'
import { FileDown, ShieldCheck, ShieldAlert, Loader2, Package } from 'lucide-react'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const ACCENT  = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'
const OK      = 'hsl(var(--status-ok))'
const DRIFT   = 'hsl(var(--status-drift))'

interface PackSummary {
  filename: string
  bytes: number
  audit_rows: number
  agents: number
  broken_agents: number
  signed: boolean
  key_id?: string
  generated_at?: string
}

export function EvidencePackWidget() {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<PackSummary | null>(null)

  async function downloadPack() {
    setDownloading(true)
    setError(null)
    try {
      const res = await gw('evidence-pack/export')
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const errJson = await res.json()
          msg = errJson?.error?.message ?? errJson?.error ?? msg
        } catch { /* keep msg */ }
        throw new Error(msg)
      }
      const text = await res.text()
      const pack = JSON.parse(text)

      // Trigger browser download from the fetched body — we already
      // have the bytes in hand and the gateway's response is opaque
      // to the browser's File-Save dialog, so re-serialize and use
      // a Blob.
      const filename =
        `aegis-evidence-${pack.meta?.org_id ?? 'default'}-${
          (pack.meta?.generated_at ?? new Date().toISOString()).replace(/[:.]/g, '-')
        }.json`
      const blob = new Blob([text], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)

      setLast({
        filename,
        bytes: text.length,
        audit_rows: Array.isArray(pack.audit_log) ? pack.audit_log.length : 0,
        agents: pack.integrity?.total_agents ?? 0,
        broken_agents: pack.integrity?.broken_agents ?? 0,
        signed: !!pack.signature,
        key_id: pack.signature?.key_id,
        generated_at: pack.meta?.generated_at,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div
      className="rounded-md p-3"
      style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div
            className="text-[10px] uppercase tracking-wider mb-0.5 inline-flex items-center gap-1.5"
            style={{ color: MUTED }}
          >
            <Package className="h-3 w-3" /> SOC 2 evidence pack
          </div>
          <p className="text-[12px] leading-snug" style={{ color: MUTED }}>
            Signed snapshot for auditor handoff.
          </p>
        </div>
        <button
          onClick={downloadPack}
          disabled={downloading}
          className="text-sm px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40 flex-shrink-0 whitespace-nowrap"
          style={{ background: ACCENT, color: ON_PRIM }}
        >
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileDown className="h-3.5 w-3.5" />
          )}
          Download pack
        </button>
      </div>

      {error && (
        <div className="mt-2 text-xs" style={{ color: DRIFT }}>
          Export failed: {error}
        </div>
      )}

      {last && !error && (
        <div className="mt-3 text-[12px]" style={{ color: MUTED }}>
          <div className="inline-flex items-center gap-2">
            {last.signed ? (
              <>
                <ShieldCheck className="h-4 w-4" style={{ color: OK }} />
                <span style={{ color: OK, fontWeight: 500 }}>Signed</span>
                {last.key_id && (
                  <span className="font-mono" style={{ color: TEXT }}>
                    key_id {last.key_id}
                  </span>
                )}
              </>
            ) : (
              <>
                <ShieldAlert className="h-4 w-4" style={{ color: DRIFT }} />
                <span style={{ color: DRIFT, fontWeight: 500 }}>Unsigned</span>
              </>
            )}
            <span>· {(last.bytes / 1024).toFixed(1)} KB</span>
          </div>
          <div className="mt-1">
            <span style={{ color: TEXT }}>{last.audit_rows.toLocaleString()}</span>{' '}
            audit rows ·{' '}
            <span
              style={{ color: last.broken_agents === 0 ? OK : DRIFT, fontWeight: 500 }}
            >
              {last.agents - last.broken_agents}/{last.agents}
            </span>{' '}
            chains intact
            {last.generated_at && (
              <span className="ml-2 font-mono" style={{ color: MUTED }}>
                · {last.generated_at}
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[11px]" style={{ color: MUTED }}>
            {last.filename}
          </div>
        </div>
      )}
    </div>
  )
}
