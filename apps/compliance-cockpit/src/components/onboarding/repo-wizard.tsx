'use client'

/**
 * Repo-onboarding wizard. Four steps:
 *
 *   1. SCAN     operator uploads / pastes the scanner JSON (from
 *               `agentguard scan` or `node tools/repo-scanner` on their box)
 *   2. DESCRIBE NL → policy bundle. Calls /api/ai/generate-policy-bundle
 *               with the operator's own LLM key (stored in Cockpit settings).
 *   3. INJECT   wizard renders the copy-ready `agentguard inject --report`
 *               command — operator runs it on their machine. Browser
 *               can't write to their local FS, so this is by design.
 *   4. REGISTER bulk POST the selected candidates to
 *               /api/v1/agents/bulk-register and stream their first
 *               sightings live on the result screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, ArrowRight, Check, ChevronRight, Code, Copy,
  FileJson, FolderOpen, Loader2, RotateCcw, ScanLine,
  ShieldCheck, Sparkles, Terminal, Wand2, ListChecks, AlertCircle,
} from 'lucide-react'
import { gw, getApiKey } from '@/lib/gateway'
import { aegisInjectRepo, aegisScanRepo, isTauri, pickDirectory } from '@/lib/tauri'
import {
  compileTemplate, describePolicy,
  type PolicyTemplate, type CompositeTemplate,
} from '@/lib/policy-templates'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const PRIMARY = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'

type Step = 0 | 1 | 2 | 3

interface ScanCandidate {
  path: string
  abs_path: string
  framework: string
  framework_name: string
  language: 'python' | 'javascript' | 'go' | 'config' | 'unknown'
  /** 'import' = SDK use (can inject); 'http' = raw URL (needs egress
   *  proxy); 'mcp' = MCP server config (needs MCP proxy). */
  kind?: 'import' | 'http' | 'mcp'
  endpoint?: string
  mcp_server?: string
  is_entry_point: boolean
  already_protected: boolean
  suggested_agent_id: string
  remediation?: { action: 'sdk-inject' | 'egress-proxy' | 'mcp-proxy' | 'review'; note: string }
}

interface ScanReport {
  root: string
  scanned_at: string
  files_scanned: number
  configs_scanned?: number
  repo: { repo_name?: string; version?: string; owner_email?: string }
  candidates: ScanCandidate[]
  summary: {
    total: number; entry_points: number; already_protected: number
    by_framework: Record<string, number>
    by_kind?: { import?: number; http?: number; mcp?: number }
  }
}

interface PolicyBundle {
  policies: Array<{
    id: string
    name: string
    description: string
    risk_level: string
    /** Grammar-constrained form (preferred). When set, the cockpit
     *  client compiles it into policy_schema before saving to the
     *  gateway, so the gateway schema-on-disk is unchanged. */
    template?: PolicyTemplate
    composite?: CompositeTemplate
    policy_schema?: any
    tests?: {
      should_block: Array<{ tool?: string; arguments: Record<string, unknown> }>
      should_allow: Array<{ tool?: string; arguments: Record<string, unknown> }>
    }
  }>
  dsl: { version: 1; rules: Array<{ name: string; when?: any; then: { decision: string; reason?: string } }> }
}

interface BundleValidation {
  rounds: number
  issues: string[]
  test_results: Array<{
    policy_id: string
    block_pass: number; block_fail: number
    allow_pass: number; allow_fail: number
  }>
  score: number
}

interface AgentRow {
  abs_path: string
  source_file: string
  framework: string
  kind: 'import' | 'http' | 'mcp'
  remediation?: ScanCandidate['remediation']
  endpoint?: string
  mcp_server?: string
  agent_id_suggested: string
  agent_id_edited: string
  name: string
  owner_email: string
  is_entry_point: boolean
  already_protected: boolean
  selected: boolean
}

export function RepoOnboardingWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(0)
  const [report, setReport] = useState<ScanReport | null>(null)
  const [description, setDescription] = useState('')
  const [bundle, setBundle] = useState<PolicyBundle | null>(null)
  const [bundleValidation, setBundleValidation] = useState<BundleValidation | null>(null)
  const [bundleErr, setBundleErr] = useState<string | null>(null)
  const [bundleLoading, setBundleLoading] = useState(false)
  const [rows, setRows] = useState<AgentRow[]>([])
  const [registerLoading, setRegisterLoading] = useState(false)
  const [registerResult, setRegisterResult] = useState<{ succeeded: number; failed: number; ids: string[] } | null>(null)
  const [llmProvider, setLlmProvider] = useState<'openai' | 'anthropic'>('openai')
  const [llmKey, setLlmKey] = useState('')

  // Pull the operator's stored AI key (used by the existing /api/ai routes)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const key  = localStorage.getItem('aegis:ai_api_key') ?? ''
    const prov = (localStorage.getItem('aegis:ai_provider') ?? 'openai') as 'openai' | 'anthropic'
    setLlmKey(key); setLlmProvider(prov)
  }, [])

  // Derive editable rows from the scan report (skip already-protected by default).
  useEffect(() => {
    if (!report) return
    const next: AgentRow[] = report.candidates
      .filter(c => !c.already_protected)
      .map(c => ({
        abs_path: c.abs_path,
        source_file: c.path,
        framework: c.framework_name,
        kind: (c.kind ?? 'import') as 'import' | 'http' | 'mcp',
        remediation: c.remediation,
        endpoint: c.endpoint,
        mcp_server: c.mcp_server,
        agent_id_suggested: c.suggested_agent_id,
        agent_id_edited:   c.suggested_agent_id,
        name:              friendlyNameFor(c.path, report.repo.repo_name),
        owner_email:       report.repo.owner_email ?? '',
        is_entry_point:    c.is_entry_point,
        already_protected: c.already_protected,
        // Pre-select import + mcp (both register cleanly); leave http
        // off by default — the operator should explicitly opt in since
        // re-pointing base_url is a manual code change.
        selected:          (c.kind ?? 'import') !== 'http' && (c.is_entry_point || c.kind === 'mcp'),
      }))
    setRows(next)
  }, [report])

  const generateBundle = useCallback(async () => {
    setBundleErr(null); setBundleLoading(true)
    try {
      const r = await fetch('/api/ai/generate-policy-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          provider: llmProvider,
          apiKey: llmKey,
          context: report ? {
            repo_name:  report.repo.repo_name,
            frameworks: Object.keys(report.summary.by_framework),
            candidate_count: report.summary.total,
            // Tool inventory grounds the generator: rule keying happens
            // on real tool names, not invented ones.
            tool_inventory: (report as any).tool_inventory ?? undefined,
            // Workflow graph (LangGraph / CrewAI / AutoGen topology)
            // enables per-node policy synthesis + sensitive-relay
            // detection at policy-generation time.
            workflow_graph: (report as any).workflow_graph ?? undefined,
            // Categorical workflow tags (legacy hint kept for prompts
            // that key off frameworks rather than full graph).
            workflow_kinds: Object.keys(report.summary.by_framework ?? {})
              .filter(f => /langgraph|crewai|autogen|mastra|vercel/i.test(f)),
          } : undefined,
        }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => null)
        throw new Error(data?.error ?? `HTTP ${r.status}`)
      }
      const data = await r.json()
      setBundle(data.bundle as PolicyBundle)
      setBundleValidation((data.validation ?? null) as BundleValidation | null)
    } catch (e: any) {
      setBundleErr(e?.message ?? 'failed to generate')
    } finally {
      setBundleLoading(false)
    }
  }, [description, llmProvider, llmKey, report])

  const register = useCallback(async () => {
    if (!report) return
    setRegisterLoading(true)
    try {
      const selected = rows.filter(r => r.selected)
      const payload = {
        agents: selected.map(r => ({
          // Pass the edited slug as the agent id — the schema accepts
          // any slug-shape, and using the same slug across re-runs makes
          // the bulk-register idempotent (promotes existing 'unregistered'
          // rows in-place instead of minting fresh UUIDs each time).
          id:           r.agent_id_edited.trim() || undefined,
          name:         r.name || undefined,
          description: `From ${r.source_file} (${r.framework})`,
          owner_email:  r.owner_email || undefined,
          source_file:  r.source_file,
        })),
      }
      const res = await gw('agents/bulk-register', { method: 'POST', body: JSON.stringify(payload) })
      const data = await res.json()
      const succeeded = (data?.results ?? []).filter((x: any) => x.ok).length
      const failed    = (data?.results ?? []).length - succeeded
      const ids       = (data?.results ?? []).filter((x: any) => x.ok).map((x: any) => x.id)
      setRegisterResult({ succeeded, failed, ids })
    } catch (e: any) {
      setRegisterResult({ succeeded: 0, failed: rows.filter(r => r.selected).length, ids: [] })
    } finally {
      setRegisterLoading(false)
    }
  }, [report, rows])

  return (
    <div style={{ background: BG, minHeight: '100vh' }}>
      <header
        className="border-b px-6 py-4 flex items-center justify-between"
        style={{ borderColor: BORDER }}
      >
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5" style={{ color: PRIMARY }} />
          <span className="font-semibold tracking-tight" style={{ color: TEXT }}>AEGIS</span>
          <span className="text-xs uppercase tracking-widest" style={{ color: MUTED }}>
            <Sparkles className="inline h-3 w-3 mr-1 -mt-0.5" /> Bring a Repo Under Guard
          </span>
        </div>
        <button
          onClick={() => router.push('/')}
          className="text-xs px-3 py-1.5 rounded border"
          style={{ color: MUTED, borderColor: BORDER, background: SURFACE }}
        >
          Skip to dashboard <ArrowRight className="inline h-3 w-3 ml-1" />
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        <StepRow step={step} />

        {step === 0 && (
          <ScanStep
            report={report}
            onReport={r => { setReport(r); setStep(1) }}
          />
        )}
        {step === 1 && report && (
          <DescribeStep
            report={report}
            description={description}
            onDescription={setDescription}
            llmProvider={llmProvider}
            setLlmProvider={setLlmProvider}
            llmKey={llmKey}
            setLlmKey={setLlmKey}
            bundle={bundle}
            validation={bundleValidation}
            err={bundleErr}
            loading={bundleLoading}
            onGenerate={generateBundle}
            onBack={() => setStep(0)}
            onContinue={() => setStep(2)}
          />
        )}
        {step === 2 && report && (
          <InjectStep
            report={report}
            rows={rows}
            onBack={() => setStep(1)}
            onContinue={() => setStep(3)}
          />
        )}
        {step === 3 && report && (
          <RegisterStep
            rows={rows}
            setRows={setRows}
            loading={registerLoading}
            result={registerResult}
            onRegister={register}
            onBack={() => setStep(2)}
            onFinish={() => router.push('/agents')}
          />
        )}
      </main>
    </div>
  )
}

function StepRow({ step }: { step: Step }) {
  const items = [
    { label: 'Scan',     icon: ScanLine },
    { label: 'Describe', icon: Wand2 },
    { label: 'Inject',   icon: Terminal },
    { label: 'Register', icon: ListChecks },
  ]
  return (
    <ol className="flex items-center gap-3 text-xs" style={{ color: MUTED }}>
      {items.map((it, i) => {
        const Icon = it.icon
        const active = i === step
        const done   = i < step
        return (
          <li key={i} className="flex items-center gap-2">
            <span
              className="inline-flex items-center justify-center h-6 w-6 rounded-full border"
              style={{
                background: active || done ? PRIMARY : SURFACE,
                color:      active || done ? ON_PRIM : MUTED,
                borderColor: active || done ? PRIMARY : BORDER,
              }}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3 w-3" />}
            </span>
            <span style={{ color: active ? TEXT : MUTED }}>{it.label}</span>
            {i < items.length - 1 && <ChevronRight className="h-3.5 w-3.5" />}
          </li>
        )
      })}
    </ol>
  )
}

// ─────────────────────────────────────────────────────────────── Step 1: SCAN
function ScanStep({ report, onReport }: { report: ScanReport | null; onReport: (r: ScanReport) => void }) {
  const [raw, setRaw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [tauri, setTauri] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [pickedPath, setPickedPath] = useState<string>('')

  useEffect(() => { setTauri(isTauri()) }, [])

  const handleFile = async (f: File) => {
    setErr(null)
    try {
      const txt = await f.text()
      setRaw(txt)
      const r = pickJsonReport(txt)
      if (!r) throw new Error('file does not contain a scanner JSON report')
      onReport(r)
    } catch (e: any) {
      setErr(e?.message ?? 'failed to parse')
    }
  }

  const handlePaste = () => {
    setErr(null)
    const r = pickJsonReport(raw)
    if (!r) { setErr('could not parse — paste the JSON from `agentguard scan --json`'); return }
    onReport(r)
  }

  const pickAndScan = async () => {
    setErr(null); setScanning(true)
    try {
      const path = await pickDirectory()
      if (!path) { setScanning(false); return }
      setPickedPath(path)
      const out = await aegisScanRepo(path)
      if (!out.ok) throw new Error(out.stderr || 'scan failed')
      if (!out.data || !out.data.candidates) throw new Error('scanner returned no report')
      onReport(out.data as ScanReport)
    } catch (e: any) {
      setErr(e?.message ?? 'scan failed')
    } finally {
      setScanning(false)
    }
  }

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl md:text-3xl leading-tight" style={{ fontFamily: 'var(--font-serif), serif', color: TEXT, letterSpacing: '-0.012em' }}>
          {tauri ? 'Pick the repo to bring under guard.' : 'Drop in a scanner report.'}
        </h1>
        <p className="text-sm max-w-2xl" style={{ color: MUTED }}>
          {tauri
            ? 'Click below to choose any folder on this machine. AEGIS will walk it and surface every file that already imports an LLM / agent framework — entry points first.'
            : 'On your machine, run agentguard scan /path/to/repo --json and either upload the file or paste the JSON below.'}
        </p>
      </header>

      {tauri ? (
        <div className="rounded-md p-5 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <div className="flex items-center gap-3">
            <button
              onClick={pickAndScan}
              disabled={scanning}
              className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
              style={{
                background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY,
                opacity: scanning ? 0.6 : 1,
              }}
            >
              {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
              {scanning ? 'Scanning…' : 'Choose folder + scan'}
            </button>
            {pickedPath && (
              <span className="text-xs font-mono truncate max-w-md" style={{ color: MUTED }} title={pickedPath}>
                {pickedPath}
              </span>
            )}
          </div>
          <p className="text-xs" style={{ color: MUTED }}>
            Skips <code className="font-mono">node_modules / .git / dist / .venv / __pycache__</code> automatically. Test files excluded by default. Nothing leaves your machine — the scan runs entirely on-disk.
          </p>
        </div>
      ) : (
        <div className="rounded-md p-5 space-y-4" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <CopyCmd label="Run on your repo" cmd="agentguard scan . --json > scan.json" />
          <CopyCmd label="Or use the standalone script" cmd="node tools/repo-scanner/index.mjs . --json > scan.json" />
          <div className="flex items-center gap-3 pt-2">
            <label
              className="text-xs px-3 py-2 rounded border inline-flex items-center gap-1.5 cursor-pointer"
              style={{ background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY }}
            >
              <FileJson className="h-3.5 w-3.5" /> Upload scan.json
              <input
                type="file"
                accept=".json,application/json"
                hidden
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
              />
            </label>
            <span style={{ color: MUTED }} className="text-xs">or paste it below.</span>
          </div>
        </div>
      )}

      {!tauri && (
        <>
          <textarea
            value={raw}
            onChange={e => setRaw(e.target.value)}
            placeholder='Paste the scanner output here. The full {"root": ..., "candidates": [...], ...} object.'
            rows={8}
            className="w-full font-mono text-[11px] px-3 py-2 rounded outline-none"
            style={{ background: SURFACE, color: TEXT, border: `1px solid ${BORDER}` }}
          />
          <div className="flex items-center justify-end">
            <button
              onClick={handlePaste}
              disabled={!raw.trim()}
              className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
              style={{
                background: raw.trim() ? PRIMARY : SURFACE,
                color:      raw.trim() ? ON_PRIM : MUTED,
                borderColor: raw.trim() ? PRIMARY : BORDER,
                opacity: raw.trim() ? 1 : 0.6,
              }}
            >
              Parse + continue <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}

      {err && (
        <p className="text-xs inline-flex items-center gap-1" style={{ color: 'hsl(0 60% 45%)' }}>
          <AlertCircle className="h-3 w-3" /> {err}
        </p>
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────── Step 2: DESCRIBE
function DescribeStep(props: {
  report: ScanReport
  description: string; onDescription: (s: string) => void
  llmProvider: 'openai' | 'anthropic'; setLlmProvider: (p: 'openai' | 'anthropic') => void
  llmKey: string; setLlmKey: (k: string) => void
  bundle: PolicyBundle | null; validation: BundleValidation | null; err: string | null; loading: boolean
  onGenerate: () => void; onBack: () => void; onContinue: () => void
}) {
  const { report, description, onDescription, llmProvider, setLlmProvider, llmKey, setLlmKey, bundle, validation, err, loading, onGenerate, onBack, onContinue } = props
  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl md:text-3xl leading-tight" style={{ fontFamily: 'var(--font-serif), serif', color: TEXT, letterSpacing: '-0.012em' }}>
          Describe what your agent does.
        </h1>
        <p className="text-sm max-w-2xl" style={{ color: MUTED }}>
          A few sentences is plenty — what the agent is for, what it should be allowed to touch, anything you want auto-blocked. Works the same whether you're a solo dev hacking on a side project or a team rolling out under audit. The wizard turns it into AJV policies plus a DSL bundle you can edit later.
        </p>
      </header>

      <div className="rounded-md p-4 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
        <ScanSummary report={report} />
      </div>

      <textarea
        value={description}
        onChange={e => onDescription(e.target.value)}
        rows={8}
        placeholder={[
          "It's a research assistant that reads my own files and calls the OpenAI API. Block any shell or destructive write.",
          'Or: a Telegram bot for my homelab — block anything that touches the prod DB or sends email to addresses outside my own domain.',
          'Or: a team-built CRM copilot — block external network calls except to api.salesforce.com, mark any DELETE statement as PENDING for human review.',
        ].join('\n\n')}
        className="w-full font-mono text-xs px-3 py-2 rounded outline-none"
        style={{ background: SURFACE, color: TEXT, border: `1px solid ${BORDER}` }}
      />

      <div className="rounded-md p-4 grid grid-cols-1 md:grid-cols-2 gap-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
        <label className="text-xs space-y-1" style={{ color: MUTED }}>
          <span>LLM Provider (uses your own key)</span>
          <select
            value={llmProvider}
            onChange={e => setLlmProvider(e.target.value as any)}
            className="block w-full text-xs px-2 py-1.5 rounded outline-none"
            style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
          >
            <option value="openai">OpenAI (gpt-4o-mini)</option>
            <option value="anthropic">Anthropic (claude-haiku)</option>
          </select>
        </label>
        <label className="text-xs space-y-1" style={{ color: MUTED }}>
          <span>API key</span>
          <input
            value={llmKey}
            onChange={e => { setLlmKey(e.target.value); try { localStorage.setItem('aegis:ai_api_key', e.target.value) } catch {} }}
            type="password"
            placeholder="sk-... or sk-ant-..."
            className="block w-full font-mono text-xs px-2 py-1.5 rounded outline-none"
            style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onGenerate}
          disabled={loading || !description.trim() || !llmKey.trim()}
          className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
          style={{
            background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY,
            opacity: loading || !description.trim() || !llmKey.trim() ? 0.6 : 1,
          }}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          {bundle ? 'Re-generate' : 'Generate policies + DSL'}
        </button>
        {err && (
          <span className="text-xs inline-flex items-center gap-1" style={{ color: 'hsl(0 60% 45%)' }}>
            <AlertCircle className="h-3 w-3" /> {err}
          </span>
        )}
      </div>

      {bundle && <BundlePreview bundle={bundle} validation={validation} />}

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm inline-flex items-center gap-1.5" style={{ color: MUTED }}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onContinue}
          className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
          style={{ background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY }}
        >
          Continue <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  )
}

function BundlePreview({ bundle, validation }: { bundle: PolicyBundle; validation?: BundleValidation | null }) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState<{ policies: number; dsl: boolean; failed: number } | null>(null)
  const [err, setErr]       = useState<string | null>(null)

  const save = async () => {
    setSaving(true); setErr(null)
    let policiesOk = 0; let failed = 0
    for (const p of bundle.policies) {
      // Resolve the JSON Schema the gateway expects. If the bundle uses
      // the grammar-constrained form (template / composite), we compile
      // it client-side so the gateway storage shape is unchanged.
      let policy_schema: any = p.policy_schema
      try {
        if (p.composite) policy_schema = compileTemplate(p.composite)
        else if (p.template) policy_schema = compileTemplate(p.template)
      } catch (e) {
        failed++
        continue
      }
      if (!policy_schema) { failed++; continue }
      try {
        const r = await gw('policies', { method: 'POST', body: JSON.stringify({
          id: p.id, name: p.name, description: p.description,
          risk_level: p.risk_level, policy_schema, enabled: true,
        }) })
        if (r.ok) policiesOk++; else failed++
      } catch { failed++ }
    }
    let dslOk = false
    try {
      const r = await gw('dsl', { method: 'PUT', body: JSON.stringify(bundle.dsl) })
      dslOk = r.ok
      if (!dslOk) failed++
    } catch { failed++ }
    setSaving(false); setSaved({ policies: policiesOk, dsl: dslOk, failed })
    if (failed > 0) setErr(`${failed} item(s) failed to save — check the Policies / DSL pages.`)
  }

  return (
    <div className="rounded-md p-4 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
      <h3 className="text-sm" style={{ color: TEXT }}>
        Generated {bundle.policies.length} policies + {bundle.dsl.rules.length} DSL rules
        {validation && (
          <span className="ml-2 text-xs" style={{ color: MUTED }}>
            (refined in {validation.rounds} round{validation.rounds === 1 ? '' : 's'}; self-test pass rate {Math.round(validation.score * 100)}%)
          </span>
        )}
      </h3>

      {validation && validation.test_results.length > 0 && (
        <div className="rounded p-2 text-[11px] space-y-1" style={{ background: BG, border: `1px solid ${BORDER}` }}>
          <p style={{ color: MUTED }}>Self-test verdict per policy:</p>
          {validation.test_results.map(t => {
            const bad = t.block_fail + t.allow_fail
            return (
              <div key={t.policy_id} className="font-mono" style={{ color: bad > 0 ? 'hsl(0 60% 45%)' : TEXT }}>
                {bad > 0 ? '✗' : '✓'} {t.policy_id} — block ok:{t.block_pass} / fail:{t.block_fail} · allow ok:{t.allow_pass} / fail:{t.allow_fail}
              </div>
            )
          })}
          {validation.issues.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer" style={{ color: MUTED }}>
                {validation.issues.length} remaining issue{validation.issues.length === 1 ? '' : 's'} (click to expand)
              </summary>
              <ul className="ml-3 mt-1 list-disc" style={{ color: 'hsl(0 60% 45%)' }}>
                {validation.issues.slice(0, 12).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="rounded p-2 text-[12px] space-y-1" style={{ background: BG, border: `1px solid ${BORDER}` }}>
        <p className="text-[11px]" style={{ color: MUTED }}>Plain-English summary:</p>
        {bundle.policies.map(p => (
          <div key={p.id} className="leading-snug" style={{ color: TEXT }}>
            <span className="font-medium">{p.name}</span>
            <span style={{ color: MUTED }}> — {describePolicy(p as any)}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <pre className="text-[11px] px-3 py-2 rounded font-mono overflow-auto max-h-72" style={{ background: BG, border: `1px solid ${BORDER}`, color: TEXT }}>
{JSON.stringify(bundle.policies, null, 2)}
        </pre>
        <pre className="text-[11px] px-3 py-2 rounded font-mono overflow-auto max-h-72" style={{ background: BG, border: `1px solid ${BORDER}`, color: TEXT }}>
{JSON.stringify(bundle.dsl, null, 2)}
        </pre>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !!saved}
          className="text-xs px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{
            background: saved ? SURFACE : PRIMARY,
            color:      saved ? PRIMARY : ON_PRIM,
            borderColor: PRIMARY,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving</>
            : saved ? <><Check className="h-3 w-3" /> Saved {saved.policies}/{bundle.policies.length} policies + {saved.dsl ? 'DSL' : 'DSL failed'}</>
            : <>Save to gateway</>}
        </button>
        {err && <span className="text-xs inline-flex items-center gap-1" style={{ color: 'hsl(0 60% 45%)' }}>
          <AlertCircle className="h-3 w-3" /> {err}
        </span>}
      </div>
      <p className="text-xs" style={{ color: MUTED }}>
        Save now and they go live immediately (hot-reloaded by the gateway). You can keep editing in Policies / DSL afterward.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────── Step 3: INJECT
function InjectStep({ report, rows, onBack, onContinue }: {
  report: ScanReport
  rows: AgentRow[]
  onBack: () => void
  onContinue: () => void
}) {
  const [tauri, setTauri] = useState(false)
  useEffect(() => { setTauri(isTauri()) }, [])

  const selected = rows.filter(r => r.selected)
  const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:8080'
  const inject = `agentguard inject --report ./scan.json${'\n'}  --gateway ${gateway} --only-entry-points`
  const apply  = `${inject} --write`
  const revert = `agentguard inject --revert ${selected.map(r => r.abs_path).join(' ')}`

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl md:text-3xl leading-tight" style={{ fontFamily: 'var(--font-serif), serif', color: TEXT, letterSpacing: '-0.012em' }}>
          Inject the bootstrap snippet.
        </h1>
        <p className="text-sm max-w-2xl" style={{ color: MUTED }}>
          {tauri
            ? 'Click Preview to see the exact diff for every entry-point file, then Apply to write the edit. Every applied file gets a .aegis.bak backup — one Revert click restores it.'
            : 'Run these locally — your browser can\'t write to your machine. Default is a dry-run diff; pass --write to apply. Every edit creates a <file>.aegis.bak so you can revert in one command.'}
        </p>
      </header>

      {tauri ? (
        <NativeInjectControls report={report} rows={rows} gateway={gateway} />
      ) : (
        <div className="rounded-md p-4 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <CopyCmd label="1. Preview the diff (dry-run, default)" cmd={inject} />
          <CopyCmd label="2. Apply the edits" cmd={apply} />
          <CopyCmd label="3. (If you change your mind) revert" cmd={revert} />
        </div>
      )}

      <p className="text-xs" style={{ color: MUTED }}>
        About to modify {selected.filter(r => r.kind === 'import').length} import-based {selected.filter(r => r.kind === 'import').length === 1 ? 'file' : 'files'}. Toggle individual rows on the next step.
      </p>

      {(selected.some(r => r.kind === 'http') || selected.some(r => r.kind === 'mcp')) && (
        <div className="rounded-md p-3 text-xs space-y-2" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <p style={{ color: TEXT }}>The selection also includes candidates the injector can't auto-edit:</p>
          <ul className="space-y-1" style={{ color: MUTED }}>
            {selected.filter(r => r.kind === 'http').slice(0, 5).map(r => (
              <li key={r.abs_path} className="font-mono">
                <KindBadge kind="http" /> {r.source_file} → use the LLM Egress Proxy
                {r.endpoint && <span style={{ color: MUTED }} className="ml-1">(endpoint: {r.endpoint})</span>}
              </li>
            ))}
            {selected.filter(r => r.kind === 'mcp').slice(0, 5).map(r => (
              <li key={r.abs_path + ':' + r.mcp_server} className="font-mono">
                <KindBadge kind="mcp" /> {r.source_file} → wire {r.mcp_server} through the AEGIS MCP proxy
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm inline-flex items-center gap-1.5" style={{ color: MUTED }}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onContinue}
          className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
          style={{ background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY }}
        >
          Continue to register <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  )
}

function NativeInjectControls({ report, rows, gateway }: { report: ScanReport; rows: AgentRow[]; gateway: string }) {
  const [busy, setBusy] = useState<null | 'dry-run' | 'write' | 'revert'>(null)
  const [results, setResults] = useState<any[] | null>(null)
  const [mode, setMode] = useState<'dry-run' | 'write' | 'revert' | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const reportJson = useMemo(() => {
    // Restrict the report passed to the injector to currently-selected rows
    // so toggles in the register table flow back into the inject preview.
    const selected = new Set(rows.filter(r => r.selected).map(r => r.abs_path))
    const next = {
      ...report,
      candidates: report.candidates.filter(c => selected.has(c.abs_path)),
    }
    return JSON.stringify(next)
  }, [report, rows])

  const run = async (m: 'dry-run' | 'write' | 'revert') => {
    setErr(null); setBusy(m); setMode(m)
    try {
      const apiKey = getApiKey()
      const out = await aegisInjectRepo({
        reportJson,
        mode: m,
        gateway,
        apiKey: apiKey || undefined,
        onlyEntryPoints: true,
        // Revert needs to see every entry, including previously-protected ones.
        includeProtected: m === 'revert',
      })
      if (!out.ok) throw new Error(out.stderr || `inject ${m} failed`)
      setResults(out.data?.results ?? [])
    } catch (e: any) {
      setErr(e?.message ?? 'inject failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-md p-4 space-y-3" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => run('dry-run')}
          disabled={busy !== null}
          className="text-sm px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{ background: SURFACE, color: TEXT, borderColor: BORDER }}
        >
          {busy === 'dry-run' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanLine className="h-3.5 w-3.5" />}
          Preview diff
        </button>
        <button
          onClick={() => run('write')}
          disabled={busy !== null}
          className="text-sm px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{ background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY }}
        >
          {busy === 'write' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          Apply edits
        </button>
        <button
          onClick={() => run('revert')}
          disabled={busy !== null}
          className="text-sm px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{ background: SURFACE, color: TEXT, borderColor: BORDER }}
        >
          {busy === 'revert' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          Revert
        </button>
      </div>

      {err && (
        <p className="text-xs inline-flex items-center gap-1" style={{ color: 'hsl(0 60% 45%)' }}>
          <AlertCircle className="h-3 w-3" /> {err}
        </p>
      )}

      {results !== null && (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: MUTED }}>
            {mode === 'dry-run' && `Planned ${results.length} file edit${results.length === 1 ? '' : 's'} — nothing written yet.`}
            {mode === 'write'   && `Applied ${results.filter(r => r.file && !r.skipped).length} edits, backups saved as .aegis.bak.`}
            {mode === 'revert'  && `Restored ${results.length} file${results.length === 1 ? '' : 's'}.`}
          </p>
          <div className="space-y-2 max-h-96 overflow-auto">
            {results.map((r, i) => (
              <div key={i} className="rounded p-2 text-[11px]" style={{ background: BG, border: `1px solid ${BORDER}` }}>
                <p className="font-mono mb-1" style={{ color: r.ok === false ? 'hsl(0 60% 45%)' : TEXT }}>
                  {r.skipped ? '–' : r.ok === false ? '✗' : '✓'} {r.file}
                  {r.agentId && <span style={{ color: MUTED }} className="ml-2">agent_id={r.agentId}</span>}
                  {r.reason && <span style={{ color: MUTED }} className="ml-2">({r.reason})</span>}
                </p>
                {r.diff && (
                  <pre className="text-[10px] font-mono whitespace-pre overflow-x-auto" style={{ color: TEXT }}>
{r.diff}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────── Step 4: REGISTER
function RegisterStep(props: {
  rows: AgentRow[]
  setRows: (r: AgentRow[]) => void
  loading: boolean
  result: { succeeded: number; failed: number; ids: string[] } | null
  onRegister: () => void
  onBack: () => void
  onFinish: () => void
}) {
  const { rows, setRows, loading, result, onRegister, onBack, onFinish } = props
  const update = (i: number, patch: Partial<AgentRow>) => {
    setRows(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }
  const selectedCount = rows.filter(r => r.selected).length

  if (result) {
    return (
      <section className="space-y-5">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-widest" style={{ color: PRIMARY }}>
            <ShieldCheck className="inline h-3 w-3 mr-1 -mt-0.5" /> Repo under guard
          </p>
          <h1 className="text-2xl md:text-3xl leading-tight" style={{ fontFamily: 'var(--font-serif), serif', color: TEXT, letterSpacing: '-0.012em' }}>
            Registered {result.succeeded} {result.succeeded === 1 ? 'agent' : 'agents'}.
          </h1>
          {result.failed > 0 && (
            <p className="text-sm" style={{ color: 'hsl(0 60% 45%)' }}>{result.failed} failed — check the registry page for details.</p>
          )}
        </header>
        <div className="rounded-md p-4 text-xs space-y-1 font-mono" style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: TEXT }}>
          {result.ids.slice(0, 20).map(id => <div key={id}>✓ {id}</div>)}
          {result.ids.length > 20 && <div style={{ color: MUTED }}>… and {result.ids.length - 20} more.</div>}
        </div>
        <p className="text-sm" style={{ color: MUTED }}>
          Once your re-run the now-instrumented entry-points, the gateway will start emitting traces immediately. Check the Traces panel or the agent's profile page.
        </p>
        <div className="flex items-center justify-between">
          <button onClick={onBack} className="text-sm" style={{ color: MUTED }}><ArrowLeft className="h-3.5 w-3.5 inline" /> Back</button>
          <button
            onClick={onFinish}
            className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
            style={{ background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY }}
          >
            Open agents page <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl md:text-3xl leading-tight" style={{ fontFamily: 'var(--font-serif), serif', color: TEXT, letterSpacing: '-0.012em' }}>
          Confirm and register.
        </h1>
        <p className="text-sm max-w-2xl" style={{ color: MUTED }}>
          One row per candidate file. Untick anything you don't want under guard. Owner is optional — only fill it in if you want it on the agents list.
        </p>
      </header>

      <div className="rounded-md overflow-x-auto" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: BG, color: MUTED }}>
              <th className="px-2 py-2 text-left"></th>
              <th className="px-2 py-2 text-left">Kind</th>
              <th className="px-2 py-2 text-left">Path</th>
              <th className="px-2 py-2 text-left">Framework</th>
              <th className="px-2 py-2 text-left">Agent ID</th>
              <th className="px-2 py-2 text-left">Friendly name</th>
              <th className="px-2 py-2 text-left">Owner</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.abs_path + ':' + (r.mcp_server ?? '')} style={{ borderTop: `1px solid ${BORDER}` }}>
                <td className="px-2 py-1">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onChange={e => update(i, { selected: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-1">
                  <KindBadge kind={r.kind} remediation={r.remediation} />
                </td>
                <td className="px-2 py-1 font-mono" style={{ color: TEXT }}>
                  {r.source_file}
                  {r.mcp_server && <span className="ml-2 text-[10px]" style={{ color: MUTED }}>→ {r.mcp_server}</span>}
                  {r.is_entry_point && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: BG, color: MUTED }}>entry</span>}
                </td>
                <td className="px-2 py-1" style={{ color: MUTED }}>{r.framework}</td>
                <td className="px-2 py-1">
                  <input
                    value={r.agent_id_edited}
                    onChange={e => update(i, { agent_id_edited: e.target.value })}
                    className="w-full font-mono text-xs px-1 py-0.5 rounded outline-none"
                    style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    value={r.name}
                    onChange={e => update(i, { name: e.target.value })}
                    className="w-full text-xs px-1 py-0.5 rounded outline-none"
                    style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    value={r.owner_email}
                    onChange={e => update(i, { owner_email: e.target.value })}
                    placeholder="owner@example.com (optional)"
                    className="w-full text-xs px-1 py-0.5 rounded outline-none"
                    style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-2 py-4 text-center" style={{ color: MUTED }}>No unprotected candidates — looks like every file in the report is already protected.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm inline-flex items-center gap-1.5" style={{ color: MUTED }}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onRegister}
          disabled={loading || selectedCount === 0}
          className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
          style={{
            background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY,
            opacity: loading || selectedCount === 0 ? 0.6 : 1,
          }}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
          Register {selectedCount} {selectedCount === 1 ? 'agent' : 'agents'}
        </button>
      </div>
    </section>
  )
}

function ScanSummary({ report }: { report: ScanReport }) {
  const fws = Object.entries(report.summary.by_framework)
  const k = report.summary.by_kind ?? {}
  return (
    <div className="text-xs grid grid-cols-1 md:grid-cols-4 gap-4">
      <div>
        <p style={{ color: MUTED }}>Repo</p>
        <p className="font-mono" style={{ color: TEXT }}>{report.repo.repo_name ?? '—'}{report.repo.version ? `@${report.repo.version}` : ''}</p>
      </div>
      <div>
        <p style={{ color: MUTED }}>Candidates</p>
        <p className="font-mono" style={{ color: TEXT }}>
          {report.summary.total} total ({report.summary.entry_points} entry-points)
        </p>
      </div>
      <div>
        <p style={{ color: MUTED }}>By kind</p>
        <p className="font-mono" style={{ color: TEXT }}>
          import:{k.import ?? 0} http:{k.http ?? 0} mcp:{k.mcp ?? 0}
        </p>
      </div>
      <div>
        <p style={{ color: MUTED }}>Frameworks</p>
        <p className="font-mono truncate" style={{ color: TEXT }} title={fws.map(([k, v]) => `${k} (${v})`).join(', ')}>
          {fws.slice(0, 3).map(([k, v]) => `${k}(${v})`).join(' ')}{fws.length > 3 && ` +${fws.length - 3}`}
        </p>
      </div>
    </div>
  )
}

function KindBadge({ kind, remediation }: { kind: 'import' | 'http' | 'mcp'; remediation?: ScanCandidate['remediation'] }) {
  // Colour-by-kind: import is the happy path (we can inject), http/mcp
  // mark candidates that need a different remediation step.
  const palette: Record<string, { bg: string; fg: string; label: string }> = {
    import: { bg: 'hsl(140 40% 90%)', fg: 'hsl(140 50% 25%)', label: 'SDK' },
    http:   { bg: 'hsl(30 80% 90%)',  fg: 'hsl(30 70% 30%)',  label: 'HTTP' },
    mcp:    { bg: 'hsl(220 60% 92%)', fg: 'hsl(220 65% 30%)', label: 'MCP' },
  }
  const p = palette[kind]
  return (
    <span
      className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-mono"
      style={{ background: p.bg, color: p.fg }}
      title={remediation?.note ?? ''}
    >
      {p.label}
    </span>
  )
}

function CopyCmd({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-1">
        <p className="text-xs" style={{ color: TEXT }}>{label}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(cmd).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="text-xs px-2 py-1 rounded border inline-flex items-center gap-1.5"
          style={{ background: BG, color: copied ? PRIMARY : TEXT, borderColor: BORDER }}
        >
          {copied ? <><Check className="h-3 w-3" /> copied</> : <><Copy className="h-3 w-3" /> copy</>}
        </button>
      </div>
      <pre className="text-[12px] leading-relaxed px-3 py-2 rounded font-mono overflow-x-auto whitespace-pre" style={{ background: BG, border: `1px solid ${BORDER}`, color: TEXT }}>
{cmd}
      </pre>
    </div>
  )
}

// ─────────────────────────────────────────────────────── helpers
function pickJsonReport(text: string): ScanReport | null {
  text = text.trim()
  if (!text) return null
  // First try direct parse.
  try {
    const j = JSON.parse(text)
    if (j?.candidates && Array.isArray(j.candidates) && j?.summary) return j as ScanReport
  } catch { /* fall through */ }
  // The scanner emits human stderr + machine JSON on stdout — try the
  // last JSON-looking line.
  const lines = text.split(/\r?\n/).reverse()
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue
    try {
      const j = JSON.parse(line)
      if (j?.candidates && j?.summary) return j as ScanReport
    } catch { /* keep trying */ }
  }
  return null
}

function friendlyNameFor(path: string, repo?: string): string {
  const base = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? path
  const dir  = path.split('/').slice(-2, -1)[0]
  if (dir && dir !== '.' && dir !== 'src') return `${dir}/${base}`
  return base
}

