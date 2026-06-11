'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight, Check, ChevronRight, Copy, Loader2, ShieldCheck,
  Terminal, Code, PlayCircle, KeyRound, Sparkles, AlertCircle,
} from 'lucide-react'
import { gw, getApiKey } from '@/lib/gateway'
import { ScenarioPicker, type ScenarioId } from './scenario-picker'
import { SnippetBlock } from './snippet-block'
import { LiveWaiting, type FirstSightingEvent } from './live-waiting'
import { snippetsFor } from './snippets'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const PRIMARY = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'

const ONBOARDED_KEY = 'aegis:onboarded'

type Step = 0 | 1 | 2

export function OnboardingWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(0)
  const [scenario, setScenario] = useState<ScenarioId | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('http://localhost:8080')
  const [apiKey, setApiKey] = useState('')
  const [firstAgent, setFirstAgent] = useState<FirstSightingEvent | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  // Boot: resolve a working API key (localStorage → bootstrap endpoint)
  // and learn whether the org already has agents (in which case the
  // wizard short-circuits and offers to skip to the dashboard).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const local = getApiKey()
        if (local) setApiKey(local)
        else {
          // Pull from the gateway's bootstrap endpoint and stash it.
          const r = await fetch('/api/gateway/auth/key', { cache: 'no-store' })
          if (r.ok) {
            const data = await r.json()
            if (data?.api_key) {
              setApiKey(data.api_key)
              try { localStorage.setItem('aegis:api_key', data.api_key) } catch {}
            }
          }
        }
        const probe = await gw('onboarding/status')
        if (cancelled) return
        if (probe.ok) {
          const status = await probe.json()
          if (status?.has_agents) {
            // Returning user. Don't trap them on the wizard.
            try { localStorage.setItem(ONBOARDED_KEY, '1') } catch {}
          }
        }
      } catch (e: any) {
        if (!cancelled) setBootError(e?.message ?? 'failed to reach gateway')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const onScenarioPicked = useCallback((id: ScenarioId) => {
    setScenario(id)
    setStep(1)
  }, [])

  const onSnippetAcknowledged = useCallback(() => {
    setStep(2)
  }, [])

  const onFirstSighting = useCallback((e: FirstSightingEvent) => {
    setFirstAgent(prev => prev ?? e)   // ignore duplicates
  }, [])

  const finish = useCallback(() => {
    try { localStorage.setItem(ONBOARDED_KEY, '1') } catch {}
    router.push('/')
  }, [router])

  const finalSnippets = useMemo(
    () => scenario ? snippetsFor(scenario, { gatewayUrl, apiKey }) : null,
    [scenario, gatewayUrl, apiKey],
  )

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
            <Sparkles className="inline h-3 w-3 mr-1 -mt-0.5" /> First-Run Setup
          </span>
        </div>
        <button
          onClick={finish}
          className="text-xs px-3 py-1.5 rounded border transition-colors"
          style={{ color: MUTED, borderColor: BORDER, background: SURFACE }}
        >
          Skip to dashboard <ArrowRight className="inline h-3 w-3 ml-1" />
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <StepIndicator step={step} />

        {bootError && (
          <div
            className="rounded-md p-3 text-xs flex items-start gap-2"
            style={{ background: SURFACE, border: `1px solid hsl(0 50% 60%)`, color: TEXT }}
          >
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: 'hsl(0 60% 45%)' }} />
            <div>
              <p>Couldn't reach the local gateway at <span className="font-mono">{gatewayUrl}</span>.</p>
              <p style={{ color: MUTED }} className="mt-1">
                Start it with <span className="font-mono">node dist/server.js</span> in
                {' '}<span className="font-mono">packages/gateway-mcp</span>, or set
                {' '}<span className="font-mono">GATEWAY_URL</span> on the cockpit.
              </p>
            </div>
          </div>
        )}

        {step === 0 && <ScenarioPicker onPick={onScenarioPicked} />}

        {step === 1 && scenario && finalSnippets && (
          <SnippetBlock
            scenario={scenario}
            snippets={finalSnippets}
            gatewayUrl={gatewayUrl}
            apiKey={apiKey}
            onGatewayUrlChange={setGatewayUrl}
            onContinue={onSnippetAcknowledged}
            onBack={() => setStep(0)}
          />
        )}

        {step === 2 && (
          <LiveWaiting
            firstAgent={firstAgent}
            onFirstSighting={onFirstSighting}
            onFinish={finish}
            onBack={() => setStep(1)}
          />
        )}
      </main>
    </div>
  )
}

function StepIndicator({ step }: { step: Step }) {
  const items: Array<{ label: string; icon: any }> = [
    { label: 'Pick framework', icon: Code },
    { label: 'Add the snippet', icon: Terminal },
    { label: 'See first agent live', icon: PlayCircle },
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
                background: active ? PRIMARY : done ? PRIMARY : SURFACE,
                color: active || done ? ON_PRIM : MUTED,
                borderColor: active || done ? PRIMARY : BORDER,
              }}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3 w-3" />}
            </span>
            <span style={{ color: active ? TEXT : MUTED }}>{it.label}</span>
            {i < items.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5" style={{ color: MUTED }} />
            )}
          </li>
        )
      })}
    </ol>
  )
}
