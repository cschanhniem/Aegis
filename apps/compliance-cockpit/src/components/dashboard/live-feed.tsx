'use client'

import { useQuery } from '@tanstack/react-query'
import { useRef, useEffect, useState } from 'react'
import { CheckCircle, AlertCircle, Shield, Clock } from 'lucide-react'
import { traceSummary } from '@/lib/trace-summary'

const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const BORDER  = 'hsl(var(--border))'
const SURFACE = 'hsl(var(--card))'
const SOFT    = 'hsl(var(--muted))'
const STRIPE  = 'hsl(var(--secondary))'
// Terminal-status accents flip via the semantic --status-* vars added
// for the alignment + code-shield panels. Keeps the BLOCK/ERROR/OK
// row prefix readable on either theme.
const OK_C    = 'hsl(var(--status-ok))'
const ATTN_C  = 'hsl(var(--status-attn))'
const ALERT_C = 'hsl(var(--status-drift))'

const TOOL_COLORS: Record<string, string> = {
  web_search:   'hsl(210 20% 48%)',
  read_file:    'hsl(270 14% 48%)',
  write_file:   'hsl(270 14% 48%)',
  execute_sql:  'hsl(232 56% 50%)',
  send_request: 'hsl(180 14% 40%)',
}

export function LiveFeed() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const prevCountRef = useRef(0)

  const { data } = useQuery({
    queryKey: ['live-feed'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=50')
      if (!res.ok) return []
      const d = await res.json()
      return (d.traces ?? []).reverse()  // oldest first
    },
    refetchInterval: 2000,
  })

  const traces: any[] = data ?? []

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current && traces.length > prevCountRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevCountRef.current = traces.length
  }, [traces.length, autoScroll])

  function handleScroll() {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40)
  }

  if (traces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2" style={{ color: MUTED }}>
        <Shield className="h-8 w-8 opacity-40" />
        <p className="text-sm">Waiting for traces...</p>
        <p className="text-xs">Activity will appear here in real-time</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: OK_C, boxShadow: `0 0 0 3px ${OK_C}33` }} />
          <span className="text-xs font-medium" style={{ color: OK_C }}>Live</span>
        </div>
        <span className="text-[10px]" style={{ color: MUTED }}>{traces.length} events</span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="rounded-lg border overflow-y-auto font-mono"
        style={{
          background: SURFACE,
          borderColor: BORDER,
          height: 380,
        }}
      >
        <div className="p-3 space-y-0">
          {traces.map((t: any, i: number) => {
            const tool = t.tool_call?.tool_name || 'unknown'
            const hasError = !!t.observation?.error
            const isBlocked = t.approval_status === 'REJECTED'
            const dur = t.observation?.duration_ms
            const ts = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            const toolColor = TOOL_COLORS[tool] || MUTED

            return (
              <div
                key={t.trace_id}
                className="flex items-center gap-2 py-1 px-2 rounded text-[11px] leading-relaxed"
                style={{
                  animation: i >= traces.length - 3 ? 'trace-slide-in 0.3s ease-out' : undefined,
                  background: i % 2 === 0 ? 'transparent' : STRIPE,
                }}
              >
                <span className="flex-shrink-0" style={{ color: MUTED }}>{ts}</span>
                {isBlocked ? (
                  <span className="flex-shrink-0 font-bold" style={{ color: ALERT_C }}>BLOCK</span>
                ) : hasError ? (
                  <span className="flex-shrink-0 font-bold" style={{ color: ATTN_C }}>ERROR</span>
                ) : (
                  <span className="flex-shrink-0 font-bold" style={{ color: OK_C }}>{'  OK '}</span>
                )}
                <span className="truncate font-medium" style={{ color: TEXT }}>{traceSummary(t)}</span>
                <span className="flex-shrink-0" style={{ color: MUTED }}>
                  {(t.agent_id ?? '').substring(0, 10)}
                </span>
                {dur != null && dur > 0 && (
                  <span className="ml-auto flex-shrink-0" style={{ color: MUTED }}>{Math.round(dur)}ms</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }}
          className="text-[11px] px-3 py-1 rounded-full"
          style={{ background: SOFT, color: TEXT, border: `1px solid ${BORDER}` }}
        >
          Scroll to latest
        </button>
      )}
    </div>
  )
}
