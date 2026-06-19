'use client'

import { useEffect, useMemo, useState } from 'react'
import { gw } from '@/lib/gateway'
import { AlertOctagon, AlertTriangle, ShieldCheck, ShieldOff, FileCode2, Wand2 } from 'lucide-react'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const ACCENT  = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'

const SEV_COLOR: Record<string, string> = {
  CRITICAL: 'hsl(var(--status-drift))',
  HIGH:     'hsl(12 55% 45%)',
  MEDIUM:   'hsl(var(--status-attn))',
  LOW:      'hsl(var(--status-ok))',
}

type Language = 'any' | 'python' | 'javascript' | 'shell' | 'sql'

interface RuleDef {
  id: string
  description: string
  severity: string
  language: string
  cwe?: string
}

interface Finding {
  rule: string
  description: string
  severity: string
  language: string
  line: number
  column: number
  snippet: string
  cwe?: string
}

interface ScanResult {
  worst: string | null
  findings: Finding[]
  unique_findings: number
  scanned_chars: number
  latency_ms: number
}

const STARTERS: { label: string; language: Language; body: string }[] = [
  {
    label: 'Python · exec + AWS key',
    language: 'python',
    body: `import os
def run(user_input):
    return eval(user_input)
AWS_KEY = "AKIA1234567890ABCDEF"
`,
  },
  {
    label: 'Shell · rm -rf $HOME',
    language: 'shell',
    body: `#!/bin/bash
set -e
echo "cleaning…"
rm -rf $HOME/.cache
sudo apt install -y curl
`,
  },
  {
    label: 'SQL · DROP + no WHERE',
    language: 'sql',
    body: `DELETE FROM users;
DROP TABLE archive;
`,
  },
  {
    label: 'JS · innerHTML XSS',
    language: 'javascript',
    body: `const cp = require("child_process")
cp.execSync("ls -la")
el.innerHTML = userText
`,
  },
]

export function CodeShieldView() {
  const [code, setCode] = useState<string>(STARTERS[0].body)
  const [language, setLanguage] = useState<Language>(STARTERS[0].language)
  const [rules, setRules] = useState<RuleDef[]>([])
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const res = await gw('code-shield/rules')
        if (!res.ok) return
        const data = await res.json()
        if (Array.isArray(data?.rules)) setRules(data.rules)
      } catch { /* leave rules empty; the panel just hides */ }
    })()
  }, [])

  const groupedRules = useMemo(() => {
    const buckets: Record<string, RuleDef[]> = {}
    for (const r of rules) {
      const k = r.language === 'any' ? 'cross-language secrets / patterns' : r.language
      if (!buckets[k]) buckets[k] = []
      buckets[k].push(r)
    }
    return Object.entries(buckets)
  }, [rules])

  async function handleScan() {
    if (!code.trim()) return
    setScanning(true)
    setError(null)
    try {
      const res = await gw('code-shield/scan', {
        method: 'POST',
        body: JSON.stringify({ code, language }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setResult(data as ScanResult)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      setScanning(false)
    }
  }

  function loadStarter(idx: number) {
    setCode(STARTERS[idx].body)
    setLanguage(STARTERS[idx].language)
    setResult(null)
  }

  const sevColor = result?.worst ? (SEV_COLOR[result.worst] ?? MUTED) : MUTED

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: TEXT }}>
            Code Shield
          </h1>
          <p className="text-sm mt-1" style={{ color: MUTED }}>
            Paste agent-generated code. AEGIS flags risky patterns in &lt; 1 ms.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            className="text-sm px-3 py-1.5 rounded-md border"
            style={{ background: SURFACE, borderColor: BORDER, color: TEXT }}
          >
            <option value="any">any</option>
            <option value="python">python</option>
            <option value="javascript">javascript</option>
            <option value="shell">shell</option>
            <option value="sql">sql</option>
          </select>
          <select
            onChange={(e) => {
              if (e.target.value) loadStarter(Number(e.target.value))
            }}
            value=""
            className="text-sm px-3 py-1.5 rounded-md border"
            style={{ background: SURFACE, borderColor: BORDER, color: TEXT }}
          >
            <option value="" disabled>Load starter…</option>
            {STARTERS.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleScan}
            disabled={scanning || !code.trim()}
            className="text-sm px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40"
            style={{ background: ACCENT, color: ON_PRIM }}
          >
            <Wand2 className="h-3.5 w-3.5" />
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>

      {/* Editor + Result */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <textarea
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="lg:col-span-2 font-mono text-[13px] leading-relaxed rounded-md border p-3 resize-none"
          style={{ background: SURFACE, borderColor: BORDER, color: TEXT, minHeight: 360 }}
          placeholder="// paste the code your agent is about to dispatch…"
        />

        <div className="space-y-2">
          {error && (
            <div
              className="text-xs rounded-md border px-3 py-2"
              style={{ background: SURFACE, borderColor: BORDER, color: SEV_COLOR.CRITICAL }}
            >
              {error}
            </div>
          )}

          {!result && !error && (
            <div
              className="text-xs rounded-md border px-3 py-6 text-center"
              style={{ background: SURFACE, borderColor: BORDER, color: MUTED }}
            >
              <FileCode2 className="h-5 w-5 mx-auto mb-1.5 opacity-50" />
              Scan to see findings here.
            </div>
          )}

          {result && (
            <div
              className="rounded-md border p-3"
              style={{ background: SURFACE, borderColor: BORDER }}
            >
              <div className="flex items-center gap-2 mb-2">
                {result.worst === null ? (
                  <>
                    <ShieldCheck className="h-4 w-4" style={{ color: SEV_COLOR.LOW }} />
                    <span className="text-sm font-medium" style={{ color: TEXT }}>Clean</span>
                  </>
                ) : (
                  <>
                    {result.worst === 'MEDIUM' ? (
                      <AlertTriangle className="h-4 w-4" style={{ color: sevColor }} />
                    ) : (
                      <AlertOctagon className="h-4 w-4" style={{ color: sevColor }} />
                    )}
                    <span className="text-sm font-medium" style={{ color: sevColor }}>
                      {result.worst}
                    </span>
                  </>
                )}
                <span className="ml-auto text-[11px]" style={{ color: MUTED }}>
                  {result.unique_findings} finding{result.unique_findings === 1 ? '' : 's'} · {result.latency_ms}ms
                </span>
              </div>
              <ul className="space-y-2">
                {result.findings.map((f, i) => (
                  <li key={i} className="text-[12px]">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
                        style={{
                          background: BG,
                          color: SEV_COLOR[f.severity] ?? MUTED,
                          border: `1px solid ${SEV_COLOR[f.severity] ?? BORDER}`,
                        }}
                      >
                        {f.severity}
                      </span>
                      <span className="font-mono" style={{ color: TEXT }}>{f.rule}</span>
                      <span className="text-[11px]" style={{ color: MUTED }}>
                        line {f.line}:{f.column}
                      </span>
                      {f.cwe && (
                        <span className="text-[10px] font-mono" style={{ color: MUTED }}>
                          {f.cwe}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: MUTED }}>
                      {f.description}
                    </div>
                    <div className="text-[11px] mt-0.5 font-mono truncate" style={{ color: MUTED }}>
                      {f.snippet}
                    </div>
                  </li>
                ))}
                {result.findings.length === 0 && (
                  <li className="text-[12px]" style={{ color: MUTED }}>
                    No rules matched.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Rules catalog */}
      {rules.length > 0 && (
        <details
          className="rounded-md border"
          style={{ background: SURFACE, borderColor: BORDER }}
        >
          <summary
            className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2"
            style={{ color: TEXT }}
          >
            <ShieldOff className="h-3.5 w-3.5" style={{ color: MUTED }} />
            Rule catalog
            <span className="text-[11px]" style={{ color: MUTED }}>
              ({rules.length} rules · live from {`/api/v1/code-shield/rules`})
            </span>
          </summary>
          <div className="px-3 pb-3 space-y-3">
            {groupedRules.map(([group, list]) => (
              <div key={group}>
                <div className="text-[11px] uppercase tracking-wider mt-2 mb-1" style={{ color: MUTED }}>
                  {group}
                </div>
                <ul className="space-y-1">
                  {list.map((r) => (
                    <li key={r.id} className="text-[12px] flex items-center gap-2">
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          background: BG,
                          color: SEV_COLOR[r.severity] ?? MUTED,
                          border: `1px solid ${SEV_COLOR[r.severity] ?? BORDER}`,
                          minWidth: 64,
                          textAlign: 'center',
                        }}
                      >
                        {r.severity}
                      </span>
                      <span className="font-mono" style={{ color: TEXT, minWidth: 180 }}>
                        {r.id}
                      </span>
                      <span style={{ color: MUTED }}>{r.description}</span>
                      {r.cwe && (
                        <span className="text-[10px] font-mono ml-auto" style={{ color: MUTED }}>
                          {r.cwe}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
