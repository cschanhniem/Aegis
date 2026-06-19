'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, ShieldAlert, Layers, X, Loader2, ExternalLink } from 'lucide-react'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(30 10% 15%)'
const BG     = '#fff'

// Colour ramp for coverage fraction. Warm light theme — pick from the
// existing palette so the page sits next to the rest of Cockpit.
function rampColour(frac: number): { bg: string; border: string; fg: string } {
  if (frac >= 1)    return { bg: 'hsl(150 30% 88%)', border: 'hsl(150 25% 70%)', fg: 'hsl(150 30% 28%)' }
  if (frac >= 0.66) return { bg: 'hsl(150 22% 92%)', border: 'hsl(150 18% 78%)', fg: 'hsl(150 24% 32%)' }
  if (frac >= 0.33) return { bg: 'hsl(36 22% 92%)',  border: 'hsl(36 18% 78%)',  fg: 'hsl(36 28% 34%)' }
  if (frac > 0)     return { bg: 'hsl(25 22% 93%)',  border: 'hsl(25 18% 78%)',  fg: 'hsl(25 28% 38%)' }
  return                    { bg: 'hsl(0 14% 95%)',  border: 'hsl(0 10% 80%)',  fg: 'hsl(0 18% 44%)' }
}

interface DetectorRef {
  name: string
  version: string
}

interface CoverageEntry {
  nodeId: string
  title: string
  tactic: string
  covered: boolean
  coveringDetectors: DetectorRef[]
}

interface CoverageSummary {
  ontologyVersion: string
  totalNodes: number
  coveredNodes: number
  coverageRatio: number
  perTactic: { tactic: string; total: number; covered: number }[]
  entries: CoverageEntry[]
}

interface OntologyTechnique {
  id: string
  kind: 'technique'
  tactic: string
  title: string
  summary: string
  mitigations: string[]
  references: string[]
}

interface OntologyDoc {
  version: string
  tactics: { id: string; slug: string; title: string; summary: string }[]
  techniques: OntologyTechnique[]
}

const TACTIC_LABEL: Record<string, string> = {
  'initial-compromise':   'Initial Compromise',
  'execution':            'Execution',
  'privilege-escalation': 'Privilege Escalation',
  'credential-access':    'Credential Access',
  'data-exfiltration':    'Data Exfiltration',
  'persistence':          'Persistence',
  'discovery':            'Discovery',
  'impact':               'Impact',
  'defense-evasion':      'Defense Evasion',
  'lateral-movement':     'Lateral Movement',
}

export function CoverageView() {
  const [filter, setFilter] = useState<'all' | 'covered' | 'uncovered'>('all')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const summaryQ = useQuery<CoverageSummary>({
    queryKey: ['coverage', 'summary'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/ontology/coverage')
      if (!res.ok) throw new Error(`coverage HTTP ${res.status}`)
      return res.json()
    },
    refetchInterval: 30000,
  })

  const ontologyQ = useQuery<OntologyDoc>({
    queryKey: ['ontology'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/ontology')
      if (!res.ok) throw new Error(`ontology HTTP ${res.status}`)
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
  })

  if (summaryQ.isLoading || ontologyQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading coverage map…
      </div>
    )
  }

  if (summaryQ.error || !summaryQ.data || !ontologyQ.data) {
    return (
      <div className="text-xs inline-flex items-start gap-2" style={{ color: 'hsl(0 60% 40%)' }}>
        <ShieldAlert className="h-3.5 w-3.5 mt-0.5" />
        Failed to load coverage map. Check gateway connectivity.
      </div>
    )
  }

  const summary = summaryQ.data
  const ontology = ontologyQ.data
  const techByNode = new Map(ontology.techniques.map(t => [t.id, t]))

  const filteredEntries = summary.entries.filter(e =>
    filter === 'all' ? true : filter === 'covered' ? e.covered : !e.covered,
  )

  const grouped = new Map<string, CoverageEntry[]>()
  for (const e of filteredEntries) {
    const arr = grouped.get(e.tactic) ?? []
    arr.push(e)
    grouped.set(e.tactic, arr)
  }

  const selected = selectedNodeId ? techByNode.get(selectedNodeId) : null
  const selectedCov = selectedNodeId ? summary.entries.find(e => e.nodeId === selectedNodeId) : null

  return (
    <div className="space-y-5" style={{ color: TEXT }}>
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Layers className="h-5 w-5" style={{ color: 'hsl(var(--primary))' }} />
          Threat coverage
        </h1>
      </div>

      {/* Overall stat */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Stat
          label="Covered nodes"
          value={`${summary.coveredNodes}/${summary.totalNodes}`}
          hint={`${(summary.coverageRatio * 100).toFixed(1)}%`}
        />
        <Stat label="Tactics" value={String(summary.perTactic.length)} hint="top-level categories" />
        <Stat
          label="Fully closed"
          value={String(summary.perTactic.filter(t => t.covered === t.total).length)}
          hint="tactic = no red squares"
        />
        <Stat
          label="Active detectors"
          value={String(new Set(summary.entries.flatMap(e => e.coveringDetectors.map(d => d.name))).size)}
          hint="registered + claiming coverage"
        />
      </div>

      {/* Tactic histogram */}
      <div className="rounded-xl border" style={{ borderColor: BORDER, background: BG }}>
        <div className="px-5 py-3 border-b" style={{ borderColor: BORDER }}>
          <p className="text-sm font-semibold">Per-tactic coverage</p>
        </div>
        <div className="px-5 py-4 space-y-2">
          {summary.perTactic.map(t => {
            const frac = t.total === 0 ? 0 : t.covered / t.total
            const c = rampColour(frac)
            return (
              <div key={t.tactic} className="flex items-center gap-3 text-xs">
                <div className="w-44 truncate" style={{ color: TEXT }}>
                  {TACTIC_LABEL[t.tactic] ?? t.tactic}
                </div>
                <div className="flex-1 h-5 rounded border overflow-hidden flex" style={{ borderColor: BORDER }}>
                  <div
                    className="flex items-center justify-center font-medium"
                    style={{ width: `${frac * 100}%`, background: c.bg, color: c.fg }}
                  >
                    {frac > 0.15 && `${t.covered}`}
                  </div>
                  <div
                    className="flex items-center justify-center"
                    style={{ width: `${(1 - frac) * 100}%`, background: 'hsl(36 14% 96%)', color: MUTED }}
                  >
                    {frac < 0.85 && `${t.total - t.covered} open`}
                  </div>
                </div>
                <div className="w-12 text-right" style={{ color: MUTED }}>
                  {(frac * 100).toFixed(0)}%
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex gap-1.5">
        {(['all', 'covered', 'uncovered'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="text-[11px] px-2 py-1 rounded border"
            style={{
              background: filter === f ? 'hsl(var(--accent))' : 'transparent',
              borderColor: filter === f ? BORDER : 'transparent',
              color: TEXT,
            }}
          >
            {f === 'all' ? 'All nodes' : f === 'covered' ? 'Covered' : 'Open / uncovered'}
          </button>
        ))}
      </div>

      {/* Node grid grouped by tactic */}
      <div className="space-y-4">
        {Array.from(grouped.entries()).map(([tactic, entries]) => (
          <div key={tactic} className="rounded-xl border" style={{ borderColor: BORDER, background: BG }}>
            <div className="px-5 py-2.5 border-b text-xs font-semibold uppercase tracking-wider" style={{ borderColor: BORDER, color: MUTED }}>
              {TACTIC_LABEL[tactic] ?? tactic} ({entries.filter(e => e.covered).length}/{entries.length})
            </div>
            <div className="p-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {entries.map(e => {
                const c = rampColour(e.covered ? 1 : 0)
                return (
                  <button
                    key={e.nodeId}
                    onClick={() => setSelectedNodeId(e.nodeId)}
                    className="text-left rounded border px-3 py-2 transition-transform hover:scale-[1.01]"
                    style={{ background: c.bg, borderColor: c.border, color: c.fg }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono">{e.nodeId}</span>
                      {e.covered
                        ? <ShieldCheck className="h-3 w-3" />
                        : <ShieldAlert className="h-3 w-3" />}
                    </div>
                    <div className="text-xs mt-1 line-clamp-2" style={{ color: TEXT }}>{e.title}</div>
                    <div className="text-[10px] mt-1" style={{ color: MUTED }}>
                      {e.coveringDetectors.length > 0
                        ? e.coveringDetectors.map(d => d.name.replace('aegis.builtin.', '')).join(', ')
                        : 'no detector'}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Detail panel */}
      {selected && selectedCov && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setSelectedNodeId(null)}>
          <div
            className="w-full max-w-xl rounded-xl p-5 space-y-3 max-h-[85vh] overflow-y-auto"
            style={{ background: BG, border: `1px solid ${BORDER}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] font-mono" style={{ color: MUTED }}>{selected.id}</div>
                <h2 className="font-semibold text-sm mt-0.5">{selected.title}</h2>
                <div className="text-[11px] mt-0.5" style={{ color: MUTED }}>
                  {TACTIC_LABEL[selected.tactic] ?? selected.tactic}
                </div>
              </div>
              <button onClick={() => setSelectedNodeId(null)} style={{ color: MUTED }}><X className="h-4 w-4" /></button>
            </div>

            <div>
              <Label>Summary</Label>
              <p className="text-xs mt-1" style={{ color: TEXT }}>{selected.summary}</p>
            </div>

            <div>
              <Label>Coverage in this deployment</Label>
              {selectedCov.coveringDetectors.length === 0 ? (
                <p className="text-xs mt-1 inline-flex items-center gap-1.5" style={{ color: 'hsl(0 18% 40%)' }}>
                  <ShieldAlert className="h-3 w-3" /> No registered detector claims this node.
                </p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {selectedCov.coveringDetectors.map(d => (
                    <li key={d.name} className="text-xs inline-flex items-center gap-1.5" style={{ color: 'hsl(150 24% 32%)' }}>
                      <ShieldCheck className="h-3 w-3" />
                      <span className="font-mono">{d.name}</span>
                      <span style={{ color: MUTED }}>v{d.version}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selected.mitigations.length > 0 && (
              <div>
                <Label>Mitigation hints</Label>
                <ul className="mt-1 space-y-1 list-disc list-inside text-xs" style={{ color: TEXT }}>
                  {selected.mitigations.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
              </div>
            )}

            {selected.references.length > 0 && (
              <div>
                <Label>References</Label>
                <ul className="mt-1 space-y-1 text-xs" style={{ color: MUTED }}>
                  {selected.references.map((r, i) => (
                    <li key={i} className="inline-flex items-center gap-1">
                      <ExternalLink className="h-3 w-3 opacity-60" /> {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border px-4 py-3" style={{ borderColor: BORDER, background: BG }}>
      <div className="text-[11px] uppercase tracking-wider" style={{ color: MUTED }}>{label}</div>
      <div className="text-xl font-semibold mt-0.5" style={{ color: TEXT }}>{value}</div>
      {hint && <div className="text-[11px] mt-0.5" style={{ color: MUTED }}>{hint}</div>}
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wider" style={{ color: MUTED }}>{children}</div>
}
