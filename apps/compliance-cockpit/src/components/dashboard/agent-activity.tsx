'use client'

import { useQuery } from '@tanstack/react-query'
import { CheckCircle, AlertCircle } from 'lucide-react'
import { ToolIcon } from '@/lib/tool-icons'

export function AgentActivity() {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-activity-real'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=50')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    staleTime: 0,
  })

  const traces: any[] = data?.traces || []

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-9 rounded animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
        ))}
      </div>
    )
  }

  if (traces.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
        No activity yet
      </div>
    )
  }

  return (
    <div className="space-y-1 overflow-y-auto max-h-72">
      {traces.slice(0, 20).map((trace: any) => {
        const toolName = trace.tool_call?.tool_name || 'unknown'
        const hasError = !!trace.observation?.error
        const durationMs = trace.observation?.duration_ms
        const prompt = trace.input_context?.prompt || ''

        return (
          <div
            key={trace.trace_id}
            className="flex items-center gap-3 px-3 py-2 rounded-md transition-colors"
            style={{ background: 'hsl(var(--secondary))' }}
          >
            {/* Tool badge — colored brand/category icon */}
            <ToolIcon name={toolName} size={22} />
            <span className="text-[12px] font-medium flex-shrink-0" style={{ color: 'hsl(var(--foreground))' }}>
              {toolName}
            </span>

            {/* Prompt preview */}
            <span className="flex-1 text-xs truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {String(prompt).slice(0, 60)}
            </span>

            {/* Duration */}
            {durationMs !== undefined && (
              <span className="text-[11px] flex-shrink-0" style={{ color: 'hsl(0 0% 56%)' }}>
                {durationMs < 1 ? '<1ms' : `${Math.round(durationMs)}ms`}
              </span>
            )}

            {/* Status */}
            <div className="flex-shrink-0">
              {hasError
                ? <AlertCircle className="h-3.5 w-3.5" style={{ color: 'hsl(0 18% 50%)' }} />
                : <CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(150 18% 44%)' }} />
              }
            </div>
          </div>
        )
      })}
    </div>
  )
}
