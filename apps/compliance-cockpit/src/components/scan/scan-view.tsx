'use client'

/**
 * Pre-deployment scan view. Triggers a fresh static-analysis scan via
 * the AEGIS gateway (which shells out to agent-audit) and renders the
 * findings with severity / OWASP / CWE / tier filters and per-row
 * drilldown.
 *
 * Two scan-trigger paths:
 *   - Tauri: native folder picker → absolute path → scan
 *   - Browser: manual absolute-path entry → scan
 *
 * The endpoint can return:
 *   - 200 + ScanReport
 *   - 412 + { binary_missing: true, error } → render install hint
 *   - 502 + { error } → render generic error
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight,
  Download, ExternalLink, FolderOpen, Loader2, ScanLine, ShieldAlert,
  ShieldCheck, Terminal,
} from 'lucide-react'
import { gw } from '@/lib/gateway'
import { isTauri, pickDirectory } from '@/lib/tauri'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const PRIMARY = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'note'
type Tier     = 'BLOCK' | 'WARN' | 'INFO'

interface Finding {
  rule_id: string
  title: string
  description?: string
  severity: Severity
  tier: Tier
  owasp_id?: string
  cwe_id?: string
  confidence?: number
  location: {
    file_path: string
    start_line?: number
    end_line?: number
    start_column?: number
  }
  remediation?: string
}

interface ScanReport {
  ok: true
  tool: { name: string; version?: string }
  findings: Finding[]
  summary: {
    total: number
    by_severity: Partial<Record<Severity, number>>
    by_tier: Partial<Record<Tier, number>>
  }
  scanned_at: string
  scan_path: string
  sarif?: unknown
  scan_id?: number
}

interface HistoryRow {
  id: number
  scan_path: string
  scanned_at: string
  scanned_by: string | null
  tool_name: string
  tool_version: string | null
  finding_count: number
  by_severity: Partial<Record<Severity, number>>
  by_tier: Partial<Record<Tier, number>>
}

interface DiffResult {
  base:    { id: number; scanned_at: string; scan_path: string }
  compare: { id: number; scanned_at: string; scan_path: string }
  added:     Finding[]
  removed:   Finding[]
  persisted: Finding[]
  summary: {
    base_count: number; compare_count: number;
    added_count: number; removed_count: number; persisted_count: number;
    block_delta: number; critical_delta: number;
  }
}

interface ScanFailure {
  ok: false
  error: string
  binary_missing?: boolean
}

type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning'; path: string }
  | { kind: 'done'; report: ScanReport }
  | { kind: 'failed'; failure: ScanFailure }

export function ScanView() {
  const [tauri, setTauri] = useState(false)
  const [path, setPath]   = useState('')
  const [state, setState] = useState<ScanState>({ kind: 'idle' })
  const [filterSeverity, setFilterSeverity] = useState<Set<Severity>>(new Set())
  const [filterTier, setFilterTier]         = useState<Set<Tier>>(new Set())
  const [expanded, setExpanded]             = useState<Set<string>>(new Set())
  const [history, setHistory]               = useState<HistoryRow[]>([])
  const [diffBase, setDiffBase]             = useState<number | null>(null)
  const [diffCompare, setDiffCompare]       = useState<number | null>(null)
  const [diff, setDiff]                     = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading]       = useState(false)

  useEffect(() => { setTauri(isTauri()) }, [])

  const refreshHistory = useCallback(async () => {
    try {
      const r = await gw('scan/history?limit=20')
      if (!r.ok) return
      const data = await r.json()
      setHistory(data?.scans ?? [])
    } catch { /* ignored */ }
  }, [])

  useEffect(() => { refreshHistory() }, [refreshHistory])

  const runDiff = useCallback(async () => {
    if (diffBase == null || diffCompare == null || diffBase === diffCompare) return
    setDiffLoading(true)
    try {
      const r = await gw(`scan/diff?base=${diffBase}&compare=${diffCompare}`)
      const data = await r.json()
      if (r.ok) setDiff(data as DiffResult)
      else      setDiff(null)
    } catch { setDiff(null) }
    finally   { setDiffLoading(false) }
  }, [diffBase, diffCompare])

  const loadFromHistory = useCallback(async (id: number) => {
    setExpanded(new Set())
    setState({ kind: 'scanning', path: '' })
    try {
      const r = await gw(`scan/history/${id}`)
      const data = await r.json()
      if (!r.ok) {
        setState({ kind: 'failed', failure: { ok: false, error: data?.error ?? 'load failed' } })
        return
      }
      setState({
        kind: 'done',
        report: {
          ok: true,
          tool: { name: data.tool_name, version: data.tool_version ?? undefined },
          findings: data.findings ?? [],
          summary: { total: data.finding_count, by_severity: data.by_severity, by_tier: data.by_tier },
          scanned_at: data.scanned_at,
          scan_path: data.scan_path,
          sarif: data.sarif,
          scan_id: data.id,
        },
      })
    } catch (e: any) {
      setState({ kind: 'failed', failure: { ok: false, error: e?.message ?? 'network error' } })
    }
  }, [])

  const pickPath = async () => {
    try {
      const picked = await pickDirectory()
      if (picked) setPath(picked)
    } catch { /* ignored */ }
  }

  const scan = useCallback(async (p: string) => {
    if (!p.trim()) return
    setState({ kind: 'scanning', path: p })
    setExpanded(new Set())
    try {
      const r = await gw('scan/repo', { method: 'POST', body: JSON.stringify({ path: p }) })
      const data = await r.json()
      if (!r.ok || data?.ok === false) {
        setState({ kind: 'failed', failure: data as ScanFailure })
        return
      }
      setState({ kind: 'done', report: data as ScanReport })
      refreshHistory()
    } catch (e: any) {
      setState({ kind: 'failed', failure: { ok: false, error: e?.message ?? 'network error' } })
    }
  }, [refreshHistory])

  const report = state.kind === 'done' ? state.report : null

  // Apply filters
  const visibleFindings = useMemo(() => {
    if (!report) return [] as Finding[]
    return report.findings.filter(f => {
      if (filterSeverity.size > 0 && !filterSeverity.has(f.severity)) return false
      if (filterTier.size > 0 && !filterTier.has(f.tier)) return false
      return true
    })
  }, [report, filterSeverity, filterTier])

  const toggleFilter = <T extends string>(set: Set<T>, value: T, setter: (s: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value); else next.add(value)
    setter(next)
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl md:text-3xl leading-tight" style={{ fontFamily: 'var(--font-serif), serif', color: TEXT, letterSpacing: '-0.012em' }}>
          Pre-deployment scan
        </h1>
        <p className="text-sm max-w-3xl" style={{ color: MUTED }}>
          Scan your repo before deploy. Findings signed into the audit log.
        </p>
      </header>

      {/* Scan controls */}
      <div className="rounded-md p-4 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
        <div className="flex flex-wrap items-center gap-2">
          {tauri && (
            <button
              onClick={pickPath}
              className="text-sm px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
              style={{ background: SURFACE, color: TEXT, borderColor: BORDER }}
            >
              <FolderOpen className="h-3.5 w-3.5" /> Choose folder
            </button>
          )}
          <input
            value={path}
            onChange={e => setPath(e.target.value)}
            placeholder="/absolute/path/to/your/agent/repo"
            className="flex-1 min-w-[280px] font-mono text-xs px-2 py-1.5 rounded outline-none"
            style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
            spellCheck={false}
          />
          <button
            onClick={() => scan(path)}
            disabled={!path.trim() || state.kind === 'scanning'}
            className="text-sm px-4 py-1.5 rounded border inline-flex items-center gap-1.5"
            style={{
              background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY,
              opacity: !path.trim() || state.kind === 'scanning' ? 0.6 : 1,
            }}
          >
            {state.kind === 'scanning' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanLine className="h-3.5 w-3.5" />}
            {state.kind === 'scanning' ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>

      {/* Past scans */}
      {history.length > 0 && (
        <HistoryList rows={history} activeId={report?.scan_id} onPick={loadFromHistory} />
      )}

      {/* Diff controls */}
      {history.length >= 2 && (
        <DiffControls
          rows={history}
          base={diffBase}    setBase={setDiffBase}
          compare={diffCompare} setCompare={setDiffCompare}
          onRun={runDiff} loading={diffLoading}
        />
      )}
      {diff && <DiffPanel diff={diff} />}

      {/* Failure state */}
      {state.kind === 'failed' && (
        <FailureCard failure={state.failure} />
      )}

      {/* Results */}
      {report && (
        <>
          <SummaryCard report={report} />

          <div className="rounded-md p-3 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <p className="text-xs" style={{ color: MUTED }}>Filter:</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span style={{ color: MUTED }}>Severity:</span>
              {(['critical', 'high', 'medium', 'low', 'note'] as Severity[]).map(s => (
                <FilterChip
                  key={s}
                  active={filterSeverity.has(s)}
                  count={report.summary.by_severity[s] ?? 0}
                  label={s}
                  onClick={() => toggleFilter(filterSeverity, s, setFilterSeverity)}
                  color={severityColor(s)}
                />
              ))}
              <span style={{ color: MUTED }} className="ml-2">Tier:</span>
              {(['BLOCK', 'WARN', 'INFO'] as Tier[]).map(t => (
                <FilterChip
                  key={t}
                  active={filterTier.has(t)}
                  count={report.summary.by_tier[t] ?? 0}
                  label={t}
                  onClick={() => toggleFilter(filterTier, t, setFilterTier)}
                  color={tierColor(t)}
                />
              ))}
              {(filterSeverity.size > 0 || filterTier.size > 0) && (
                <button
                  onClick={() => { setFilterSeverity(new Set()); setFilterTier(new Set()) }}
                  className="text-xs"
                  style={{ color: MUTED }}
                >
                  clear filters
                </button>
              )}
            </div>
          </div>

          <FindingsTable
            findings={visibleFindings}
            total={report.findings.length}
            expanded={expanded}
            onToggle={(id) => {
              const next = new Set(expanded)
              if (next.has(id)) next.delete(id); else next.add(id)
              setExpanded(next)
            }}
          />
        </>
      )}
    </div>
  )
}

function FailureCard({ failure }: { failure: ScanFailure }) {
  if (failure.binary_missing) {
    return (
      <div className="rounded-md p-4 space-y-2" style={{ background: SURFACE, border: `1px solid hsl(38 80% 50%)` }}>
        <p className="inline-flex items-center gap-2 text-sm" style={{ color: TEXT }}>
          <Terminal className="h-4 w-4" style={{ color: 'hsl(38 80% 40%)' }} />
          <strong>agent-audit not installed on the gateway host</strong>
        </p>
        <p className="text-xs" style={{ color: MUTED }}>
          Install it via pipx (or any Python env) where the gateway runs:
        </p>
        <pre className="text-[12px] px-3 py-2 rounded font-mono" style={{ background: BG, border: `1px solid ${BORDER}`, color: TEXT }}>
{`pipx install agent-audit==0.18.2
# or:
python3 -m pip install --user agent-audit==0.18.2`}
        </pre>
        <p className="text-[11px]" style={{ color: MUTED }}>
          You can also set <span className="font-mono">PRE_DEPLOY_SCAN_BIN</span> to the absolute
          path of the binary if it lives outside <span className="font-mono">PATH</span>.
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-md p-3 text-xs inline-flex items-center gap-2" style={{ background: SURFACE, border: `1px solid hsl(0 60% 50%)`, color: TEXT }}>
      <AlertCircle className="h-4 w-4" style={{ color: 'hsl(0 60% 45%)' }} /> {failure.error}
    </div>
  )
}

function SummaryCard({ report }: { report: ScanReport }) {
  const blockCount = report.summary.by_tier.BLOCK ?? 0
  const heading = blockCount > 0 ? 'BLOCK-level findings present' : report.summary.total === 0 ? 'Clean scan' : 'Findings present'
  const Icon = blockCount > 0 ? ShieldAlert : ShieldCheck
  const color = blockCount > 0 ? 'hsl(0 60% 45%)' : report.summary.total === 0 ? 'hsl(140 50% 35%)' : 'hsl(38 70% 40%)'

  const downloadSarif = () => {
    if (!report.sarif) return
    const blob = new Blob([JSON.stringify(report.sarif, null, 2)], { type: 'application/sarif+json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `aegis-scan-${new Date(report.scanned_at).toISOString().replace(/[:.]/g, '-')}.sarif`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-md p-4 grid grid-cols-2 md:grid-cols-6 gap-4 items-center" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
      <div className="md:col-span-2">
        <p className="inline-flex items-center gap-2 text-sm" style={{ color }}>
          <Icon className="h-4 w-4" /> <strong>{heading}</strong>
        </p>
        <p className="text-xs mt-1 font-mono truncate" style={{ color: MUTED }} title={report.scan_path}>
          {report.scan_path || '—'}
        </p>
        <p className="text-[11px] mt-1" style={{ color: MUTED }}>
          {report.tool.name}{report.tool.version ? ` ${report.tool.version}` : ''} · {new Date(report.scanned_at).toLocaleString()}
        </p>
      </div>
      <Metric label="Total"    value={report.summary.total} color={TEXT} />
      <Metric label="Critical" value={report.summary.by_severity.critical ?? 0} color={severityColor('critical')} />
      <Metric label="BLOCK"    value={report.summary.by_tier.BLOCK ?? 0} color={tierColor('BLOCK')} />
      <div className="flex justify-end">
        <button
          onClick={downloadSarif}
          disabled={!report.sarif}
          title={report.sarif ? 'Download SARIF v2.1.0 — upload to GitHub Code Scanning / GitLab SAST' : 'No SARIF available'}
          className="text-xs px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{ background: SURFACE, color: TEXT, borderColor: BORDER, opacity: report.sarif ? 1 : 0.5 }}
        >
          <Download className="h-3 w-3" /> SARIF
        </button>
      </div>
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>{label}</p>
      <p className="font-mono text-xl" style={{ color }}>{value}</p>
    </div>
  )
}

function FilterChip({ label, count, active, onClick, color }: {
  label: string; count: number; active: boolean; onClick: () => void; color: string;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border"
      style={{
        background: active ? color : SURFACE,
        color: active ? '#fff' : TEXT,
        borderColor: active ? color : BORDER,
        opacity: count === 0 ? 0.5 : 1,
      }}
    >
      <span className="uppercase">{label}</span>
      <span className="opacity-70">({count})</span>
    </button>
  )
}

function FindingsTable({ findings, total, expanded, onToggle }: {
  findings: Finding[]; total: number; expanded: Set<string>; onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-md overflow-hidden" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
      <div className="px-3 py-2 text-xs flex items-center justify-between" style={{ borderBottom: `1px solid ${BORDER}`, color: MUTED }}>
        <span>Findings ({findings.length}{findings.length !== total && ` of ${total}`})</span>
      </div>
      {findings.length === 0 && (
        <div className="px-3 py-6 text-center text-xs" style={{ color: MUTED }}>
          {total === 0 ? 'No findings — clean scan.' : 'No findings match the current filters.'}
        </div>
      )}
      <ul className="divide-y" style={{ borderColor: BORDER }}>
        {findings.map(f => {
          const id = findingKey(f)
          const open = expanded.has(id)
          return (
            <li key={id} className="px-3 py-2" style={{ background: open ? BG : 'transparent' }}>
              <button
                onClick={() => onToggle(id)}
                className="w-full text-left flex items-center gap-2"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <SeverityBadge sev={f.severity} />
                <TierBadge tier={f.tier} />
                <span className="font-mono text-[11px]" style={{ color: MUTED }}>{f.rule_id}</span>
                <span className="text-xs flex-1 truncate" style={{ color: TEXT }}>{f.title}</span>
                <span className="font-mono text-[11px] truncate max-w-md" style={{ color: MUTED }} title={f.location.file_path}>
                  {f.location.file_path}{f.location.start_line ? `:${f.location.start_line}` : ''}
                </span>
              </button>
              {open && (
                <div className="mt-2 ml-6 text-xs space-y-2">
                  {f.description && (
                    <p style={{ color: TEXT }}>{f.description}</p>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]" style={{ color: MUTED }}>
                    {f.owasp_id && <div><span className="opacity-70">OWASP:</span> <span className="font-mono">{f.owasp_id}</span></div>}
                    {f.cwe_id   && <div><span className="opacity-70">CWE:</span> <span className="font-mono">{f.cwe_id}</span></div>}
                    {typeof f.confidence === 'number' && <div><span className="opacity-70">Confidence:</span> <span className="font-mono">{f.confidence.toFixed(2)}</span></div>}
                  </div>
                  {f.remediation && (
                    <div className="rounded p-2 text-[11px]" style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: TEXT }}>
                      <span className="opacity-70 mr-1">Remediation:</span>
                      {f.remediation.startsWith('http') ? (
                        <a href={f.remediation} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1" style={{ color: PRIMARY }}>
                          {f.remediation} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span>{f.remediation}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function SeverityBadge({ sev }: { sev: Severity }) {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-mono"
          style={{ background: severityColor(sev), color: '#fff' }}>
      {sev}
    </span>
  )
}
function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-mono"
          style={{ background: tierColor(tier), color: '#fff' }}>
      {tier}
    </span>
  )
}

function severityColor(sev: Severity): string {
  switch (sev) {
    case 'critical': return 'hsl(0 70% 45%)'
    case 'high':     return 'hsl(15 75% 45%)'
    case 'medium':   return 'hsl(38 75% 45%)'
    case 'low':      return 'hsl(200 50% 45%)'
    case 'note':     return 'hsl(0 0% 50%)'
  }
}
function tierColor(tier: Tier): string {
  switch (tier) {
    case 'BLOCK': return 'hsl(0 60% 45%)'
    case 'WARN':  return 'hsl(38 70% 45%)'
    case 'INFO':  return 'hsl(0 0% 50%)'
  }
}

function findingKey(f: Finding): string {
  return `${f.rule_id}::${f.location.file_path}::${f.location.start_line ?? 0}::${f.title}`
}

function DiffControls({ rows, base, compare, setBase, setCompare, onRun, loading }: {
  rows: HistoryRow[]; base: number | null; compare: number | null;
  setBase: (n: number | null) => void; setCompare: (n: number | null) => void;
  onRun: () => void; loading: boolean;
}) {
  const fmt = (r: HistoryRow) => `#${r.id} · ${new Date(r.scanned_at).toLocaleString()} · ${r.finding_count} findings`
  return (
    <div className="rounded-md p-3 flex flex-wrap items-center gap-2" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
      <span className="text-xs" style={{ color: MUTED }}>Diff:</span>
      <select
        value={base ?? ''}
        onChange={e => setBase(e.target.value ? Number(e.target.value) : null)}
        className="text-xs px-2 py-1 rounded outline-none"
        style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
      >
        <option value="">base scan…</option>
        {rows.map(r => <option key={r.id} value={r.id}>{fmt(r)}</option>)}
      </select>
      <span className="text-xs" style={{ color: MUTED }}>→</span>
      <select
        value={compare ?? ''}
        onChange={e => setCompare(e.target.value ? Number(e.target.value) : null)}
        className="text-xs px-2 py-1 rounded outline-none"
        style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
      >
        <option value="">compare scan…</option>
        {rows.map(r => <option key={r.id} value={r.id}>{fmt(r)}</option>)}
      </select>
      <button
        onClick={onRun}
        disabled={base == null || compare == null || base === compare || loading}
        className="text-xs px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
        style={{
          background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY,
          opacity: base == null || compare == null || base === compare || loading ? 0.5 : 1,
        }}
      >
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Compare
      </button>
    </div>
  )
}

function DiffPanel({ diff }: { diff: DiffResult }) {
  const s = diff.summary
  return (
    <div className="rounded-md overflow-hidden" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
      <div className="px-3 py-2 text-xs flex flex-wrap items-center gap-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <span style={{ color: TEXT }}>#{diff.base.id} → #{diff.compare.id}</span>
        <span style={{ color: MUTED }}>{s.base_count} → {s.compare_count} findings</span>
        <span style={{ color: 'hsl(0 60% 45%)' }}>+{s.added_count} new</span>
        <span style={{ color: 'hsl(140 50% 35%)' }}>−{s.removed_count} fixed</span>
        <span style={{ color: MUTED }}>{s.persisted_count} carried over</span>
        <span style={{ color: s.block_delta > 0 ? 'hsl(0 60% 45%)' : s.block_delta < 0 ? 'hsl(140 50% 35%)' : MUTED }}>
          BLOCK Δ {s.block_delta > 0 ? '+' : ''}{s.block_delta}
        </span>
        <span style={{ color: s.critical_delta > 0 ? 'hsl(0 60% 45%)' : s.critical_delta < 0 ? 'hsl(140 50% 35%)' : MUTED }}>
          Critical Δ {s.critical_delta > 0 ? '+' : ''}{s.critical_delta}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
        <DiffColumn title="Added (regressions)"    color="hsl(0 60% 45%)"    findings={diff.added} />
        <DiffColumn title="Removed (fixed)"         color="hsl(140 50% 35%)"  findings={diff.removed} />
        <DiffColumn title="Persisted (carried over)" color={MUTED}            findings={diff.persisted} />
      </div>
    </div>
  )
}

function DiffColumn({ title, color, findings }: { title: string; color: string; findings: Finding[] }) {
  return (
    <div style={{ borderRight: `1px solid ${BORDER}` }}>
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider" style={{ color, borderBottom: `1px solid ${BORDER}` }}>
        {title} ({findings.length})
      </div>
      {findings.length === 0 && (
        <div className="px-3 py-4 text-center text-xs" style={{ color: MUTED }}>—</div>
      )}
      <ul className="divide-y" style={{ borderColor: BORDER }}>
        {findings.slice(0, 50).map((f, i) => (
          <li key={i} className="px-3 py-2 text-xs flex items-center gap-2">
            <SeverityBadge sev={f.severity} />
            <span className="font-mono text-[11px]" style={{ color: MUTED }}>{f.rule_id}</span>
            <span className="flex-1 truncate" style={{ color: TEXT }}>{f.title}</span>
            <span className="font-mono text-[10px] truncate max-w-[14rem]" style={{ color: MUTED }} title={f.location.file_path}>
              {f.location.file_path}{f.location.start_line ? `:${f.location.start_line}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {findings.length > 50 && (
        <div className="px-3 py-2 text-[11px]" style={{ color: MUTED }}>… and {findings.length - 50} more.</div>
      )}
    </div>
  )
}

function HistoryList({ rows, activeId, onPick }: {
  rows: HistoryRow[]; activeId?: number; onPick: (id: number) => void;
}) {
  return (
    <details className="rounded-md" style={{ background: SURFACE, border: `1px solid ${BORDER}` }} open>
      <summary className="px-3 py-2 cursor-pointer text-xs" style={{ color: MUTED }}>
        Recent scans ({rows.length})
      </summary>
      <ul className="divide-y" style={{ borderColor: BORDER }}>
        {rows.map(r => {
          const blocks = r.by_tier.BLOCK ?? 0
          const crit = r.by_severity.critical ?? 0
          const active = activeId === r.id
          return (
            <li key={r.id}>
              <button
                onClick={() => onPick(r.id)}
                className="w-full px-3 py-2 text-left flex items-center gap-3 text-xs"
                style={{ background: active ? BG : 'transparent', color: TEXT }}
              >
                <span className="font-mono text-[10px]" style={{ color: MUTED, minWidth: 36 }}>#{r.id}</span>
                <span className="font-mono truncate flex-1" title={r.scan_path}>{r.scan_path}</span>
                <span className="font-mono text-[10px]" style={{ color: MUTED }}>{new Date(r.scanned_at).toLocaleString()}</span>
                <span className="font-mono" style={{ color: blocks > 0 ? tierColor('BLOCK') : MUTED }}>
                  {r.finding_count} {blocks > 0 ? `· ${blocks} BLOCK` : ''} {crit > 0 ? `· ${crit} crit` : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
