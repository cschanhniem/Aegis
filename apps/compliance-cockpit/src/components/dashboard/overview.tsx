'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { gw } from '@/lib/gateway'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Search, X, ArrowRight, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { RecentTraces } from './recent-traces'
import { AgentActivity } from './agent-activity'
import { AnomalyPanel } from './anomaly-panel'
import { CostPanel } from './cost-panel'
import { SessionsPanel } from './sessions-panel'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(30 10% 15%)'

function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [open, setOpen]   = useState(false)
  const router = useRouter()

  const { data: traces } = useQuery({
    queryKey: ['search-traces', query],
    queryFn: async () => {
      if (!query.trim()) return []
      const res = await fetch(`/api/gateway/traces?limit=200`)
      if (!res.ok) return []
      const d = await res.json()
      return d.traces ?? []
    },
    enabled: query.trim().length >= 2,
    staleTime: 5000,
  })

  const results = useMemo(() => {
    if (!query.trim() || !traces?.length) return []
    const q = query.toLowerCase()
    return traces.filter((t: any) => {
      const hay = [t.trace_id, t.agent_id, t.tool_call?.tool_name, t.input_context?.prompt]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    }).slice(0, 6)
  }, [query, traces])

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: MUTED }} />
        <input
          className="w-full rounded-lg pl-10 pr-10 py-2.5 text-sm border outline-none transition-shadow"
          style={{ borderColor: open && results.length > 0 ? 'hsl(38 20% 46% / 0.4)' : BORDER, background: '#fff', color: TEXT, boxShadow: open && results.length > 0 ? '0 4px 16px hsl(38 20% 46% / 0.08)' : 'none' }}
          placeholder="Search agents, tools, trace IDs..."
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
        {query && (
          <button onClick={() => { setQuery(''); setOpen(false) }} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: MUTED }}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 rounded-lg border overflow-hidden" style={{ background: '#fff', borderColor: BORDER, boxShadow: '0 8px 24px hsl(30 10% 15% / 0.08)' }}>
          {results.map((t: any) => (
            <button
              key={t.trace_id}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
              style={{ color: TEXT }}
              onMouseDown={() => { router.push(`/traces?id=${t.trace_id}`); setOpen(false); setQuery('') }}
              onMouseEnter={e => (e.currentTarget.style.background = 'hsl(36 14% 95%)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{t.tool_call?.tool_name || 'unknown'}</p>
                <p className="text-[10px] truncate" style={{ color: MUTED }}>{t.agent_id} · {t.trace_id.substring(0, 8)}</p>
              </div>
              <ArrowRight className="h-3 w-3 flex-shrink-0" style={{ color: MUTED }} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  const queryClient = useQueryClient()
  const [seeding, setSeeding] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)

  async function seedDemo() {
    setSeeding(true)
    setSeedError(null)
    try {
      const res = await gw('seed', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      }
      // Invalidate every dashboard query so the new traces flow in
      // immediately rather than waiting for the 10s poll.
      await queryClient.invalidateQueries()
    } catch (e: any) {
      setSeedError(e.message ?? 'Seed failed')
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Real-time monitoring of AI agent activities and compliance
        </p>
      </div>

      <div
        className="rounded-lg p-8 md:p-10 text-center space-y-4"
        style={{
          background: 'hsl(var(--card))',
          border: `1px solid ${BORDER}`,
        }}
      >
        <div className="inline-flex items-center justify-center mx-auto" style={{ color: MUTED }}>
          <span className="relative inline-flex h-3 w-3" aria-hidden="true">
            <span
              className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
              style={{ background: 'hsl(var(--primary))' }}
            />
            <span
              className="relative inline-flex rounded-full h-3 w-3"
              style={{ background: 'hsl(var(--primary))' }}
            />
          </span>
          <span className="ml-2 text-xs uppercase tracking-widest">Listening</span>
        </div>

        <h2
          className="text-2xl"
          style={{
            fontFamily: 'var(--font-serif), Georgia, serif',
            color: 'hsl(var(--foreground))',
            letterSpacing: '-0.012em',
          }}
        >
          Nothing has come through AEGIS yet.
        </h2>
        <p className="text-sm max-w-xl mx-auto" style={{ color: MUTED }}>
          The gateway is up and the dashboard is wired — it just hasn't seen
          its first tool call. Plug your agent in, or load a few sample
          traces to feel how the dashboard reacts.
        </p>

        <div className="pt-3 flex items-center justify-center gap-3 flex-wrap">
          <Link
            href="/welcome"
            className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-md"
            style={{
              background: 'hsl(var(--primary))',
              color: 'hsl(var(--primary-foreground))',
            }}
          >
            Open Welcome <ArrowRight className="h-3.5 w-3.5" />
          </Link>

          <button
            onClick={seedDemo}
            disabled={seeding}
            className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-md border"
            style={{
              background: 'transparent',
              color: 'hsl(var(--foreground))',
              borderColor: BORDER,
              opacity: seeding ? 0.5 : 1,
            }}
          >
            {seeding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {seeding ? 'Seeding…' : 'See it with sample data'}
          </button>
        </div>

        {seedError && (
          <p className="text-xs pt-1" style={{ color: 'hsl(0 50% 38%)' }}>
            {seedError}
          </p>
        )}

        <p className="text-[11px] pt-3" style={{ color: MUTED, opacity: 0.7 }}>
          Sample traces are seeded directly into your local SQLite DB.
          Wipe them anytime by deleting <code>~/Library/Application Support/com.aojieyuan.aegis/aegis.db</code>.
        </p>
      </div>
    </div>
  )
}

export function DashboardOverview() {
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const response = await fetch('/api/gateway/stats')
      if (!response.ok) throw new Error('Failed to fetch stats')
      return response.json()
    },
    refetchInterval: 10_000,
  })

  const trendLabel = (value: number | undefined) => {
    if (value === undefined || value === null) return null
    const sign = value > 0 ? '+' : ''
    const color = value > 0 ? 'hsl(150 18% 40%)' : value < 0 ? 'hsl(0 14% 46%)' : 'hsl(var(--muted-foreground))'
    return (
      <span style={{ color }}>{sign}{value}% vs prev hour</span>
    )
  }

  // First-run empty state: no traces in the gateway yet. Send the user
  // to /welcome where the SDK snippets + process scanner live, OR offer
  // a one-click "give me sample data so I can see what this looks like".
  const noData = stats !== undefined && (stats?.totalTraces ?? 0) === 0
  if (noData) {
    return <EmptyState />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <div className="w-80 flex-shrink-0">
          <GlobalSearch />
        </div>
      </div>

      {/* Pending checks alert banner */}
      {(stats?.pendingChecks ?? 0) > 0 && (
        <Link
          href="/approvals"
          className="flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors"
          style={{
            background: 'hsl(38 30% 95%)',
            borderColor: 'hsl(38 24% 78%)',
            color: 'hsl(30 14% 25%)',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'hsl(38 30% 92%)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'hsl(38 30% 95%)')}
        >
          <span className="flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0"
            style={{ background: 'hsl(38 28% 88%)' }}>
            <AlertTriangle className="h-4 w-4" style={{ color: 'hsl(30 30% 38%)' }} />
          </span>
          <p className="flex-1 text-sm font-semibold">
            {stats.pendingChecks} awaiting approval
          </p>
          <ArrowRight className="h-4 w-4 flex-shrink-0" style={{ color: 'hsl(30 10% 55%)' }} />
        </Link>
      )}

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">{(stats?.totalTraces || 0).toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">{(stats?.activeAgents || 0).toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums" style={{ color: (stats?.pendingChecks ?? 0) > 0 ? 'hsl(30 30% 38%)' : undefined }}>
              {(stats?.pendingChecks || 0).toLocaleString()}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Blocked 24h</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">{(stats?.violations24h || 0).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground" hidden>
              {trendLabel(stats?.violationsTrend) ?? `${stats?.blockedAgents || 0} agents blocked`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="activity" className="space-y-4">
        <TabsList>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="anomalies">Anomalies</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
            <Card className="col-span-4">
              <CardHeader>
                <CardTitle>Agent Activity</CardTitle>
              </CardHeader>
              <CardContent className="pl-2">
                <AgentActivity />
              </CardContent>
            </Card>
            <Card className="col-span-3">
              <CardHeader>
                <CardTitle>Recent Traces</CardTitle>
              </CardHeader>
              <CardContent>
                <RecentTraces />
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="anomalies" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Anomalies</CardTitle>
            </CardHeader>
            <CardContent>
              <AnomalyPanel />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="costs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Costs</CardTitle>
            </CardHeader>
            <CardContent>
              <CostPanel />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="sessions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Sessions</CardTitle>
            </CardHeader>
            <CardContent>
              <SessionsPanel />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}