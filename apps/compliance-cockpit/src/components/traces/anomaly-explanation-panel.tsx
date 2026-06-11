'use client'

/**
 * AnomalyExplanationPanel — SHAP-style attribution rendering.
 *
 * Surfaces the AnomalyResult.explanation block: a one-sentence
 * human summary + top-K feature contributors with signed
 * contribution bars. The operator sees WHY a score was high
 * instead of an opaque number.
 *
 * Design note: contributions can be negative (a feature pushed the
 * score DOWN, i.e. looked normal). We render those in muted grey on
 * the opposite side of a centered axis so operators can spot both
 * "what made it anomalous" and "what would have made it MORE
 * anomalous but didn't."
 */

import React from 'react'

const MUTED = 'hsl(var(--muted-foreground))'
const TEXT  = 'hsl(var(--foreground))'
const BG    = 'hsl(var(--background))'
const BORDER = 'hsl(var(--border))'
const ANOMALY = 'hsl(0 14% 52%)'
const NORMAL  = 'hsl(140 35% 45%)'

export interface FeatureContribution {
  index: number
  name: string
  contribution: number
  raw_value: number
}

export interface AnomalyExplanation {
  contributions: number[]
  top_features: FeatureContribution[]
  human_text: string
}

const DESCRIPTIONS: Record<string, string> = {
  tool_novelty:           'tool was never used before',
  tool_frequency_ratio:   'tool is being called much more often than usual',
  tool_recency_rank:      'tool hasn\'t been used recently',
  arg_jaccard_distance:   'arguments have unusual keys',
  arg_length_zscore:      'arguments are unusually long',
  arg_key_count_ratio:    'unusual number of argument keys',
  hour_deviation:         'call time of day is unusual',
  interval_zscore:        'inter-call gap is unusual',
  burst_ratio:            'call rate just spiked',
  ppm_surprise:           'tool-call sequence is unexpected',
  bigram_unlikeliness:    'this tool rarely follows the previous one',
  cost_zscore:            'token cost is unusual',
  risk_ordinal:           'tool is high-risk',
  high_risk_rate_ratio:   'high-risk calls just spiked',
  call_rate_ratio:        'overall call rate is anomalous',
  tool_rate_ratio:        'this tool\'s rate is anomalous',
}

export function AnomalyExplanationPanel({ explanation }: { explanation: AnomalyExplanation }) {
  if (!explanation || !explanation.top_features?.length) return null
  const maxAbs = Math.max(...explanation.top_features.map(f => Math.abs(f.contribution)), 0.01)

  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs leading-relaxed" style={{ color: TEXT }}>
        {explanation.human_text}
      </p>

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>
          Top contributors
        </p>
        {explanation.top_features.map(f => {
          const pct = Math.min(100, (Math.abs(f.contribution) / maxAbs) * 100)
          const isAnomalous = f.contribution > 0
          const color = isAnomalous ? ANOMALY : NORMAL
          return (
            <div key={f.index} className="space-y-0.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono flex-1 truncate" style={{ color: TEXT }} title={f.name}>
                  {DESCRIPTIONS[f.name] ?? f.name}
                </span>
                <span className="font-mono" style={{ color: MUTED }}>
                  raw {f.raw_value.toFixed(2)}
                </span>
                <span className="font-mono" style={{ color }}>
                  {isAnomalous ? '+' : ''}{f.contribution.toFixed(3)}
                </span>
              </div>
              <div
                className="h-1 rounded-full overflow-hidden"
                style={{ background: BG, border: `1px solid ${BORDER}` }}
              >
                <div
                  className="h-full"
                  style={{ width: `${pct}%`, background: color, transition: 'width 200ms' }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
