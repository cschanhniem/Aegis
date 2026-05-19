'use client'

import { useEffect, useState } from 'react'
import { Check, Loader2, Layers } from 'lucide-react'
import { gw } from '@/lib/gateway'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const ACCENT = 'hsl(var(--primary))'
const PANEL  = 'hsl(var(--card))'
const SOFT   = 'hsl(var(--background))'

interface TemplateMeta {
  name: 'dev' | 'standard' | 'strict' | 'financial' | 'healthcare'
  description: string
}

interface TenantConfig {
  deploymentMode: string
  layers: {
    l1: { enabled: boolean; threshold?: number }
    l2: { enabled: boolean; threshold?: number }
    l3: { enabled: boolean; threshold?: number }
  }
  retention: { days: number; enforcePII: boolean }
  thresholds: { anomalyScore: number; pendingTimeoutSec: number }
}

export function DeploymentMode() {
  const [templates, setTemplates] = useState<TemplateMeta[]>([])
  const [config, setConfig]       = useState<TenantConfig | null>(null)
  const [loading, setLoading]     = useState(true)
  const [applying, setApplying]   = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [cfgRes, tplRes] = await Promise.all([gw('config'), gw('config/templates')])
        if (!cancelled && cfgRes.ok) setConfig(await cfgRes.json())
        if (!cancelled && tplRes.ok) setTemplates((await tplRes.json()).templates ?? [])
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function apply(name: TemplateMeta['name']) {
    setApplying(name)
    setError(null)
    try {
      const res = await gw('config/apply-template', {
        method: 'POST',
        body: JSON.stringify({ template: name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setConfig(data)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setApplying(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm" style={{ color: MUTED }}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </div>
    )
  }

  const current = config?.deploymentMode ?? 'unknown'

  return (
    <div className="space-y-4">
      {/* Current snapshot */}
      <div
        className="flex items-baseline justify-between gap-3 flex-wrap rounded-md p-3"
        style={{ background: SOFT, border: `1px solid ${BORDER}` }}
      >
        <div className="text-sm">
          <span style={{ color: MUTED }}>Current mode</span>{' '}
          <span className="font-medium" style={{ color: TEXT }}>{current}</span>
          {config && (
            <span className="ml-3 text-xs" style={{ color: MUTED }}>
              L1 {config.layers.l1.enabled ? 'on' : 'off'} ·
              L2 {config.layers.l2.enabled ? 'on' : 'off'} ·
              L3 {config.layers.l3.enabled ? 'on' : 'off'} ·
              retention {config.retention.days}d
              {config.retention.enforcePII && ' · PII enforced'}
            </span>
          )}
        </div>
        {justSaved && (
          <span className="text-xs inline-flex items-center gap-1" style={{ color: ACCENT }}>
            <Check className="h-3 w-3" /> applied — live for new tool calls
          </span>
        )}
      </div>

      <p className="text-xs" style={{ color: MUTED }}>
        Apply a preset template. Settings hot-reload — no gateway restart needed.
        Custom changes are made via the
        {' '}<code className="px-1 py-0.5 rounded" style={{ background: SOFT, border: `1px solid ${BORDER}`, fontSize: '0.72rem' }}>/api/v1/config</code> API
        or the <a href="/dsl" className="underline" style={{ color: TEXT }}>DSL editor</a>.
      </p>

      {/* Template cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {templates.map((t) => {
          const isCurrent = t.name === current
          const isApplying = applying === t.name
          return (
            <button
              key={t.name}
              onClick={() => apply(t.name)}
              disabled={isApplying || isCurrent}
              className="text-left p-3 rounded-md border transition-colors disabled:cursor-default"
              style={{
                background: isCurrent ? SOFT : PANEL,
                borderColor: isCurrent ? ACCENT : BORDER,
              }}
              onMouseEnter={e => {
                if (!isCurrent && !isApplying) (e.currentTarget as HTMLElement).style.borderColor = ACCENT
              }}
              onMouseLeave={e => {
                if (!isCurrent && !isApplying) (e.currentTarget as HTMLElement).style.borderColor = BORDER
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium inline-flex items-center gap-1.5" style={{ color: TEXT }}>
                  <Layers className="h-3.5 w-3.5" /> {t.name}
                </span>
                {isCurrent && <span className="text-[10px] uppercase tracking-wider" style={{ color: ACCENT }}>active</span>}
                {isApplying && <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: MUTED }} />}
              </div>
              <p className="text-xs leading-snug" style={{ color: MUTED }}>
                {t.description}
              </p>
            </button>
          )
        })}
      </div>

      {error && (
        <p className="text-xs" style={{ color: 'hsl(0 50% 45%)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
