'use client'

import { useState } from 'react'
import { Check, Copy, ArrowRight, ArrowLeft, ExternalLink } from 'lucide-react'
import type { SnippetSet } from './snippets'
import type { ScenarioId } from './scenario-picker'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const PRIMARY = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'

export function SnippetBlock(props: {
  scenario: ScenarioId
  snippets: SnippetSet
  gatewayUrl: string
  apiKey: string
  onGatewayUrlChange: (s: string) => void
  onContinue: () => void
  onBack: () => void
}) {
  const { snippets, gatewayUrl, apiKey, onGatewayUrlChange, onContinue, onBack } = props
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  const copy = (idx: number, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(c => (c === idx ? null : c)), 1500)
  }

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1
          className="text-2xl md:text-3xl leading-tight"
          style={{ fontFamily: 'var(--font-serif), ui-serif, Georgia, serif', color: TEXT, letterSpacing: '-0.012em' }}
        >
          {snippets.title}
        </h1>
        <p className="text-sm max-w-2xl" style={{ color: MUTED }}>
          {snippets.blurb}
        </p>
      </header>

      {/* Gateway URL editor — small but important for non-localhost setups */}
      <div
        className="rounded-md p-3 flex items-center gap-3 text-xs"
        style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
      >
        <span className="font-mono uppercase tracking-wider" style={{ color: MUTED }}>Gateway</span>
        <input
          value={gatewayUrl}
          onChange={e => onGatewayUrlChange(e.target.value)}
          className="font-mono text-xs flex-1 px-2 py-1 rounded outline-none"
          style={{ background: BG, color: TEXT, border: `1px solid ${BORDER}` }}
          spellCheck={false}
        />
        <span className="font-mono uppercase tracking-wider" style={{ color: MUTED }}>API key</span>
        <span
          className="font-mono text-xs px-2 py-1 rounded"
          style={{ background: BG, color: apiKey ? TEXT : 'hsl(0 60% 45%)', border: `1px solid ${BORDER}` }}
        >
          {apiKey ? apiKey.slice(0, 14) + '…' : 'NOT SET'}
        </span>
      </div>

      <ol className="space-y-3">
        {snippets.blocks.map((b, i) => (
          <li key={i} className="rounded-md p-4" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-sm" style={{ color: TEXT }}>{b.label}</p>
              <button
                onClick={() => copy(i, b.body)}
                className="text-xs px-2 py-1 rounded border inline-flex items-center gap-1.5 transition-colors"
                style={{ background: BG, color: copiedIdx === i ? PRIMARY : TEXT, borderColor: BORDER }}
                aria-label="Copy snippet"
              >
                {copiedIdx === i ? (
                  <><Check className="h-3 w-3" /> copied</>
                ) : (
                  <><Copy className="h-3 w-3" /> copy</>
                )}
              </button>
            </div>
            <pre
              className="text-[12px] leading-relaxed px-3 py-2 rounded overflow-x-auto font-mono whitespace-pre"
              style={{ background: BG, border: `1px solid ${BORDER}`, color: TEXT }}
            >
{b.body}
            </pre>
          </li>
        ))}
      </ol>

      {snippets.docsHref && (
        <a
          href={snippets.docsHref}
          target="_blank"
          rel="noreferrer"
          className="text-xs inline-flex items-center gap-1 transition-colors"
          style={{ color: MUTED }}
        >
          Full docs <ExternalLink className="h-3 w-3" />
        </a>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="text-sm inline-flex items-center gap-1.5 transition-colors"
          style={{ color: MUTED }}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onContinue}
          className="text-sm px-4 py-2 rounded border inline-flex items-center gap-1.5"
          style={{ background: PRIMARY, color: ON_PRIM, borderColor: PRIMARY }}
        >
          I've added it — watch for the first call <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  )
}
