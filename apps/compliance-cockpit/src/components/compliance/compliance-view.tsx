'use client'

import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  FileCheck2, Download, Copy, Check, Loader2,
  ChevronRight, ChevronDown, Terminal, Hash, Stamp,
} from 'lucide-react'

// ── design tokens (dev-friendly: density + monospace bias) ──────────────
const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(30 10% 15%)'
const BG     = '#fff'
const CODE_BG = 'hsl(36 14% 96%)'
const CODE_BORDER = 'hsl(36 12% 86%)'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

type Framework = 'soc2' | 'iso27001' | 'nist-ai-rmf' | 'eu-ai-act'
type Status = 'covered' | 'partial' | 'uncovered'

interface ControlDef {
  framework: Framework
  id: string
  title: string
  summary: string
  evidenceSpec: any
}

interface BundleControl {
  id: string
  framework: Framework
  title: string
  summary: string
  status: Status
  evidence: any
}

interface Bundle {
  framework: Framework
  org_id: string
  generated_at: string
  ontology_version: string
  controls: BundleControl[]
  summary: { total_controls: number; covered: number; partial: number; uncovered: number }
  bundle_hash: string
  signature: { algorithm: string; key_id: string; signature: string; public_key_pem: string }
  transparency_log_entry?: { index: number; tree_size: number }
}

const FRAMEWORK_LABEL: Record<Framework, string> = {
  'soc2':        'SOC 2',
  'iso27001':    'ISO 27001:2022',
  'nist-ai-rmf': 'NIST AI RMF',
  'eu-ai-act':   'EU AI Act',
}

const STATUS_GLYPH: Record<Status, string> = {
  covered:   '✓',
  partial:   '◐',
  uncovered: '✗',
}
const STATUS_FG: Record<Status, string> = {
  covered:   'hsl(150 24% 32%)',
  partial:   'hsl(36 28% 38%)',
  uncovered: 'hsl(0 18% 44%)',
}

// ── component ────────────────────────────────────────────────────────────

export function ComplianceView() {
  const [framework, setFramework] = useState<Framework>('soc2')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<'evidence' | 'signature' | 'curl' | null>('evidence')

  const controlsQ = useQuery({
    queryKey: ['compliance', 'controls', framework],
    queryFn: async () => {
      const res = await fetch(`/api/gateway/compliance/controls/${framework}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      return j.controls as ControlDef[]
    },
    staleTime: 60_000,
  })

  const bundleM = useMutation({
    mutationFn: async (fw: Framework) => {
      const res = await fetch(`/api/gateway/compliance/bundle/${fw}`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<Bundle>
    },
  })

  // Auto-generate a bundle when framework changes so the page always
  // shows current evidence — feels live, not action-required.
  useEffect(() => {
    bundleM.mutate(framework)
    setSelectedId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framework])

  const bundle = bundleM.data
  const selected = useMemo(
    () => bundle?.controls.find(c => c.id === selectedId) ?? bundle?.controls[0],
    [bundle, selectedId],
  )

  return (
    <div style={{ color: TEXT, fontFamily: 'inherit' }} className="space-y-4">
      {/* Header — dev-style, no marketing card */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold inline-flex items-center gap-2">
            <FileCheck2 className="h-5 w-5" style={{ color: 'hsl(var(--primary))' }} />
            Compliance
          </h1>
          <p className="text-xs mt-1" style={{ color: MUTED }}>
            Signed evidence bundles per framework — auditor-ready artifact emitted by{' '}
            <Code>POST /api/v1/compliance/bundle/&lt;framework&gt;</Code>. Bundle hash signed
            with the gateway&apos;s Ed25519 key, inclusion logged to the transparency tree.
          </p>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => bundleM.mutate(framework)}
            disabled={bundleM.isPending}
            className="text-xs px-2.5 py-1 rounded border inline-flex items-center gap-1.5 disabled:opacity-40"
            style={{ borderColor: BORDER, color: TEXT, background: 'transparent', fontFamily: MONO }}
          >
            {bundleM.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Terminal className="h-3 w-3" />}
            regenerate
          </button>
          {bundle && (
            <button
              onClick={() => downloadJson(bundle, `aegis-bundle-${bundle.framework}-${new Date(bundle.generated_at).toISOString().slice(0, 10)}.json`)}
              className="text-xs px-2.5 py-1 rounded inline-flex items-center gap-1.5"
              style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', fontFamily: MONO }}
            >
              <Download className="h-3 w-3" /> bundle.json
            </button>
          )}
        </div>
      </header>

      {/* Framework tabs — terminal style */}
      <nav className="flex gap-0 border-b" style={{ borderColor: BORDER, fontFamily: MONO }}>
        {(Object.keys(FRAMEWORK_LABEL) as Framework[]).map(fw => {
          const active = framework === fw
          return (
            <button
              key={fw}
              onClick={() => setFramework(fw)}
              className="text-xs px-3 py-1.5 transition-colors"
              style={{
                color: active ? TEXT : MUTED,
                borderBottom: active ? `2px solid hsl(var(--primary))` : '2px solid transparent',
                fontWeight: active ? 600 : 400,
                marginBottom: '-1px',
              }}
            >
              <span style={{ opacity: 0.5 }}>$ </span>{fw}
            </button>
          )
        })}
      </nav>

      {/* Summary line — terminal output style */}
      {bundle && (
        <div
          className="text-xs px-3 py-2 rounded border"
          style={{ background: CODE_BG, borderColor: CODE_BORDER, fontFamily: MONO, color: TEXT }}
        >
          <span style={{ color: MUTED }}>frame</span>={bundle.framework}
          {' '}<span style={{ color: MUTED }}>ontology</span>=v{bundle.ontology_version}
          {' '}<span style={{ color: STATUS_FG.covered }}>✓{bundle.summary.covered}</span>
          {' '}<span style={{ color: STATUS_FG.partial }}>◐{bundle.summary.partial}</span>
          {' '}<span style={{ color: STATUS_FG.uncovered }}>✗{bundle.summary.uncovered}</span>
          {' /'}{bundle.summary.total_controls}
          {' '}<span style={{ color: MUTED }}>hash</span>={bundle.bundle_hash.slice(0, 14)}…
          {bundle.transparency_log_entry && (
            <>
              {' '}<span style={{ color: MUTED }}>tlog</span>=#{bundle.transparency_log_entry.index}
              /size={bundle.transparency_log_entry.tree_size}
            </>
          )}
          {' '}<span style={{ color: MUTED }}>at</span>={new Date(bundle.generated_at).toISOString()}
        </div>
      )}

      {/* Two-pane: control table + selected evidence */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* LEFT: control list (dense table, no padding excess) */}
        <div className="lg:col-span-2 rounded border" style={{ borderColor: BORDER, background: BG }}>
          <div className="text-[11px] uppercase tracking-wider px-3 py-2 border-b" style={{ borderColor: BORDER, color: MUTED, fontFamily: MONO }}>
            controls/
          </div>
          {controlsQ.isLoading && (
            <div className="px-3 py-4 text-xs inline-flex items-center gap-1.5" style={{ color: MUTED }}>
              <Loader2 className="h-3 w-3 animate-spin" /> loading…
            </div>
          )}
          {bundle?.controls.map(c => {
            const active = selected?.id === c.id
            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className="w-full text-left px-3 py-1.5 border-b text-xs flex items-baseline gap-2"
                style={{
                  borderColor: BORDER,
                  background: active ? 'hsl(var(--accent))' : 'transparent',
                  fontFamily: MONO,
                }}
              >
                <span style={{ color: STATUS_FG[c.status], width: '1em', flexShrink: 0 }}>
                  {STATUS_GLYPH[c.status]}
                </span>
                <span style={{ color: TEXT, fontWeight: 500, width: '5.5em', flexShrink: 0 }}>
                  {c.id}
                </span>
                <span style={{ color: MUTED, fontFamily: 'inherit', fontSize: '11px' }} className="truncate">
                  {c.title}
                </span>
              </button>
            )
          })}
        </div>

        {/* RIGHT: evidence + signature + curl */}
        <div className="lg:col-span-3 space-y-3">
          {selected && (
            <div className="rounded border" style={{ borderColor: BORDER, background: BG }}>
              <div className="px-4 py-3 border-b" style={{ borderColor: BORDER }}>
                <div className="flex items-baseline gap-2">
                  <span style={{ color: STATUS_FG[selected.status], fontFamily: MONO }}>{STATUS_GLYPH[selected.status]}</span>
                  <span className="font-mono text-sm font-medium">{selected.id}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: CODE_BG, color: MUTED, fontFamily: MONO }}>
                    {selected.framework}
                  </span>
                  <span className="text-xs uppercase tracking-wider" style={{ color: STATUS_FG[selected.status], fontFamily: MONO }}>
                    {selected.status}
                  </span>
                </div>
                <div className="text-sm mt-1.5">{selected.title}</div>
                <p className="text-xs mt-1" style={{ color: MUTED }}>{selected.summary}</p>
              </div>

              {/* Collapsible: evidence JSON */}
              <Section
                title="evidence"
                icon={<Hash className="h-3 w-3" />}
                open={expanded === 'evidence'}
                onToggle={() => setExpanded(expanded === 'evidence' ? null : 'evidence')}
                copyValue={JSON.stringify(selected.evidence, null, 2)}
              >
                <pre
                  className="text-[11px] leading-snug px-3 py-2 overflow-x-auto"
                  style={{ background: CODE_BG, fontFamily: MONO, color: TEXT, margin: 0 }}
                >
                  {JSON.stringify(selected.evidence, null, 2)}
                </pre>
              </Section>
            </div>
          )}

          {/* Bundle-wide signature */}
          {bundle && (
            <div className="rounded border" style={{ borderColor: BORDER, background: BG }}>
              <Section
                title="signature"
                icon={<Stamp className="h-3 w-3" />}
                open={expanded === 'signature'}
                onToggle={() => setExpanded(expanded === 'signature' ? null : 'signature')}
                copyValue={JSON.stringify({
                  bundle_hash: bundle.bundle_hash,
                  signature: bundle.signature,
                  transparency_log_entry: bundle.transparency_log_entry,
                }, null, 2)}
              >
                <div className="px-3 py-2 text-[11px]" style={{ fontFamily: MONO, color: TEXT, background: CODE_BG }}>
                  <KV k="algorithm" v={bundle.signature.algorithm} />
                  <KV k="bundle_hash" v={bundle.bundle_hash} mono />
                  <KV k="signature (b64, trunc)" v={bundle.signature.signature.slice(0, 64) + '…'} mono />
                  {bundle.transparency_log_entry && (
                    <>
                      <KV k="tlog.index" v={String(bundle.transparency_log_entry.index)} />
                      <KV k="tlog.tree_size" v={String(bundle.transparency_log_entry.tree_size)} />
                    </>
                  )}
                  <details className="mt-1.5">
                    <summary className="cursor-pointer" style={{ color: MUTED }}>public_key_pem</summary>
                    <pre className="mt-1 text-[10px]" style={{ margin: 0 }}>{bundle.signature.public_key_pem}</pre>
                  </details>
                </div>
              </Section>

              {/* Verify recipe — copyable */}
              <Section
                title="verify offline"
                icon={<Terminal className="h-3 w-3" />}
                open={expanded === 'curl'}
                onToggle={() => setExpanded(expanded === 'curl' ? null : 'curl')}
                copyValue={verifyRecipe(bundle)}
              >
                <pre
                  className="text-[11px] leading-snug px-3 py-2 overflow-x-auto"
                  style={{ background: CODE_BG, fontFamily: MONO, color: TEXT, margin: 0 }}
                >
                  {verifyRecipe(bundle)}
                </pre>
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── small primitives ─────────────────────────────────────────────────────

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1 py-0.5 rounded text-[11px]" style={{ background: CODE_BG, fontFamily: MONO, color: TEXT }}>
      {children}
    </code>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span style={{ color: MUTED, minWidth: '12ch' }}>{k}</span>
      <span className="break-all" style={{ color: TEXT, fontFamily: mono ? MONO : 'inherit' }}>{v}</span>
    </div>
  )
}

function Section({
  title, icon, open, onToggle, copyValue, children,
}: {
  title: string
  icon: React.ReactNode
  open: boolean
  onToggle: () => void
  copyValue: string
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(copyValue)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="border-t" style={{ borderColor: BORDER }}>
      <div className="flex items-center justify-between px-3 py-1.5">
        <button onClick={onToggle} className="text-xs inline-flex items-center gap-1.5" style={{ color: TEXT, fontFamily: MONO }}>
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {icon} <span>{title}</span>
        </button>
        <button onClick={copy} className="text-[10px] inline-flex items-center gap-1" style={{ color: MUTED, fontFamily: MONO }}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {open && children}
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────

function downloadJson(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function verifyRecipe(bundle: Bundle): string {
  return [
    `# 1. Save the bundle to disk (e.g. bundle.json).`,
    `# 2. Reconstruct the canonical-JSON body the gateway signed.`,
    `# 3. Verify with Node + the AEGIS-published pubkey.`,
    ``,
    `node - <<'JS'`,
    `const fs = require('fs'); const crypto = require('crypto');`,
    `const b = JSON.parse(fs.readFileSync('bundle.json', 'utf8'));`,
    `const body = { framework: b.framework, org_id: b.org_id, ontology_version: b.ontology_version, controls: b.controls, summary: b.summary };`,
    `function canon(v) { if (v===null||typeof v!=='object') return JSON.stringify(v);`,
    `  if (Array.isArray(v)) return '['+v.map(canon).join(',')+']';`,
    `  return '{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[c])=>a<c?-1:1)`,
    `    .map(([k,x])=>JSON.stringify(k)+':'+canon(x)).join(',')+'}'; }`,
    `const pub = crypto.createPublicKey(b.signature.public_key_pem);`,
    `const ok = crypto.verify(null, Buffer.from(canon(body)), pub, Buffer.from(b.signature.signature, 'base64'));`,
    `console.log(ok ? 'OK' : 'FAIL');`,
    `JS`,
    ``,
    `# Cross-check the embedded pubkey against the AEGIS-pinned one:`,
    `#   curl -s https://raw.githubusercontent.com/Justin0504/Aegis/main/.well-known/aegis-release-pubkey.pem`,
    `#   (the LITERAL bytes must match bundle.signature.public_key_pem)`,
  ].join('\n')
}
