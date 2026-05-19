'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { Loader2, Save, FlaskConical, Trash2, FileCode, Sparkles } from 'lucide-react'
import { gw } from '@/lib/gateway'

// Monaco is heavy — load only on the client when the page mounts.
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-sm" style={{ color: MUTED }}>
      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading editor…
    </div>
  ),
})

// Read from the shared design tokens defined in globals.css :root so the page
// automatically follows any palette update (currently the Claude-cream theme).
const BG = 'hsl(var(--background))'
const PANEL = 'hsl(var(--card))'
const BORDER = 'hsl(var(--border))'
const TEXT = 'hsl(var(--foreground))'
const MUTED = 'hsl(var(--muted-foreground))'
const ACCENT = 'hsl(var(--primary))'
const RED = 'hsl(var(--destructive))'
const GREEN = 'hsl(150 22% 38%)' // no green token in palette; component-local

interface DslExample {
  id: string
  name: string
  description: string
  dsl: unknown
}

const EMPTY_DSL = `version: 1
rules:
  - name: example-rule
    when:
      classifier.category: shell
    then:
      decision: block
      reason: "shell tools disabled"
`

const SAMPLE_CONTEXT = JSON.stringify(
  {
    classifier: { category: 'network', signals: ['content:network'] },
    anomaly: { score: 0.65, decision: 'flag' },
    policy: { passed: true, riskLevel: 'LOW', violations: [] },
    tool: { name: 'fetch_url', args: { url: 'https://example.com/api' } },
    agent: { id: 'agent-uuid-here' },
    tenant: { id: 'default', deploymentMode: 'standard' },
  },
  null,
  2,
)

function tryParseDsl(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'Empty document' }
  // Accept JSON directly
  if (trimmed.startsWith('{')) {
    try {
      return { ok: true, value: JSON.parse(trimmed) }
    } catch (e) {
      return { ok: false, error: `JSON parse error: ${(e as Error).message}` }
    }
  }
  // Otherwise treat as YAML — but we don't bundle a YAML parser, so we use a
  // minimal "is this likely YAML?" check and ask the user to use JSON for now.
  // Most enterprise users will edit JSON; a YAML mode lives behind a flag.
  return {
    ok: false,
    error: 'Use JSON format for now. (Tip: copy from the example.)',
  }
}

const DEFAULT_JSON = `{
  "version": 1,
  "rules": [
    {
      "name": "pending-high-anomaly",
      "when": { "anomaly.score": { ">": 0.7 } },
      "then": { "decision": "pending", "reason": "anomaly score above 0.7" }
    }
  ]
}
`

export function DslEditorView() {
  const [editorText, setEditorText] = useState<string>(DEFAULT_JSON)
  const [savedDsl, setSavedDsl] = useState<unknown>(null)
  const [examples, setExamples] = useState<DslExample[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dryRunCtx, setDryRunCtx] = useState<string>(SAMPLE_CONTEXT)
  const [dryRunResult, setDryRunResult] = useState<unknown>(null)

  useEffect(() => {
    (async () => {
      try {
        const [dslRes, exRes] = await Promise.all([gw('dsl'), gw('dsl/examples')])
        if (dslRes.ok) {
          const data = await dslRes.json()
          if (data?.dsl) {
            setSavedDsl(data.dsl)
            setEditorText(JSON.stringify(data.dsl, null, 2))
          }
        }
        if (exRes.ok) {
          const data = await exRes.json()
          if (Array.isArray(data.examples)) setExamples(data.examples)
        }
      } catch (e) {
        toast.error('Failed to load DSL: ' + (e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const parsed = useMemo(() => tryParseDsl(editorText), [editorText])
  const isDirty =
    parsed.ok && JSON.stringify(parsed.value) !== JSON.stringify(savedDsl)

  async function handleSave() {
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    setSaving(true)
    try {
      const res = await gw('dsl', {
        method: 'PUT',
        body: JSON.stringify(parsed.value),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setSavedDsl(data.dsl)
      toast.success('DSL saved. Live for new tool calls.')
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm('Delete the current DSL? Tool calls will fall back to default policies.')) return
    setSaving(true)
    try {
      const res = await gw('dsl', { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setSavedDsl(null)
      setEditorText(DEFAULT_JSON)
      toast.success('DSL removed.')
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDryRun() {
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    let ctx: unknown
    try {
      ctx = JSON.parse(dryRunCtx)
    } catch (e) {
      toast.error('Sample context is not valid JSON')
      return
    }
    try {
      const res = await gw('dsl/dry-run', {
        method: 'POST',
        body: JSON.stringify({ dsl: parsed.value, context: ctx }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setDryRunResult(data.match ?? null)
    } catch (e) {
      toast.error('Dry-run failed: ' + (e as Error).message)
    }
  }

  function loadExample(id: string) {
    const ex = examples.find((e) => e.id === id)
    if (!ex) return
    setEditorText(JSON.stringify(ex.dsl, null, 2))
    toast.info(`Loaded "${ex.name}" — review then Save to apply.`)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: TEXT }}>
            Policy DSL
          </h1>
          <p className="text-sm mt-1" style={{ color: MUTED }}>
            Per-tenant rules that tighten the defaults. Fail-safe: rules can
            escalate (allow → pending/block) but never relax an AJV or anomaly
            block.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            onChange={(e) => {
              if (e.target.value) loadExample(e.target.value)
              e.target.value = ''
            }}
            className="text-sm px-3 py-1.5 rounded-md border"
            style={{ background: PANEL, borderColor: BORDER, color: TEXT }}
            defaultValue=""
          >
            <option value="" disabled>
              <Sparkles className="inline h-3 w-3 mr-1" /> Load example…
            </option>
            {examples.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleDelete}
            disabled={!savedDsl || saving}
            className="text-sm px-3 py-1.5 rounded-md border inline-flex items-center gap-1.5 disabled:opacity-40"
            style={{ background: PANEL, borderColor: BORDER, color: RED }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
          <button
            onClick={handleSave}
            disabled={!parsed.ok || !isDirty || saving}
            className="text-sm px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40"
            style={{ background: ACCENT, color: 'white' }}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>
      </div>

      {/* Status row */}
      <div
        className="flex items-center justify-between text-xs px-3 py-2 rounded-md border"
        style={{ background: PANEL, borderColor: BORDER, color: MUTED }}
      >
        <span className="inline-flex items-center gap-1.5">
          <FileCode className="h-3.5 w-3.5" />
          {loading
            ? 'Loading…'
            : savedDsl
              ? `Saved DSL: ${(savedDsl as any).rules?.length ?? 0} rule(s)`
              : 'No DSL saved — default policies apply unchanged.'}
        </span>
        {isDirty && (
          <span style={{ color: ACCENT }}>● unsaved changes</span>
        )}
        {!parsed.ok && (
          <span style={{ color: RED }}>{parsed.error}</span>
        )}
      </div>

      {/* Editor + Side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div
          className="lg:col-span-2 rounded-md border overflow-hidden"
          style={{ background: PANEL, borderColor: BORDER, minHeight: 480 }}
        >
          <MonacoEditor
            height="480px"
            language="json"
            theme="vs"
            value={editorText}
            onChange={(v) => setEditorText(v ?? '')}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              tabSize: 2,
              wordWrap: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        </div>

        <div className="space-y-3">
          {/* Dry-run */}
          <div
            className="rounded-md border p-3 space-y-2"
            style={{ background: PANEL, borderColor: BORDER }}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium inline-flex items-center gap-1.5" style={{ color: TEXT }}>
                <FlaskConical className="h-3.5 w-3.5" /> Dry-run
              </h3>
              <button
                onClick={handleDryRun}
                disabled={!parsed.ok}
                className="text-xs px-2 py-1 rounded border disabled:opacity-40"
                style={{ background: BG, borderColor: BORDER, color: TEXT }}
              >
                Run
              </button>
            </div>
            <p className="text-[11px]" style={{ color: MUTED }}>
              Evaluate current draft against a sample context — no save.
            </p>
            <textarea
              value={dryRunCtx}
              onChange={(e) => setDryRunCtx(e.target.value)}
              spellCheck={false}
              className="w-full text-[11px] font-mono px-2 py-2 rounded border"
              rows={10}
              style={{ background: BG, borderColor: BORDER, color: TEXT }}
            />
            <div
              className="text-xs px-2 py-2 rounded border min-h-[64px] font-mono whitespace-pre-wrap"
              style={{
                background: BG,
                borderColor: BORDER,
                color: dryRunResult ? TEXT : MUTED,
              }}
            >
              {dryRunResult
                ? JSON.stringify(dryRunResult, null, 2)
                : 'No match yet — click Run.'}
            </div>
          </div>

          {/* Semantics cheat-sheet */}
          <div
            className="rounded-md border p-3 text-[11px] space-y-1"
            style={{ background: PANEL, borderColor: BORDER, color: MUTED }}
          >
            <div style={{ color: TEXT }} className="font-medium mb-1">
              Decision merge
            </div>
            <div>
              <code>strictest</code>(AJV, anomaly, DSL) wins.
            </div>
            <div>
              Order: <code style={{ color: RED }}>block</code> &gt;{' '}
              <code style={{ color: ACCENT }}>pending</code> &gt;{' '}
              <code style={{ color: GREEN }}>allow</code>.
            </div>
            <div className="pt-1">
              DSL <code style={{ color: GREEN }}>allow</code> can never
              override an AJV/anomaly block.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
