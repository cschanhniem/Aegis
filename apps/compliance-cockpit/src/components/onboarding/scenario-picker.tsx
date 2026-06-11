'use client'

import { Code2, PlayCircle, FileCode2, Terminal } from 'lucide-react'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const PRIMARY = 'hsl(var(--primary))'

export type ScenarioId = 'python' | 'javascript' | 'demo' | 'proxy'

interface Scenario {
  id: ScenarioId
  title: string
  blurb: string
  icon: any
  tag: string
}

const SCENARIOS: Scenario[] = [
  {
    id: 'python',
    title: 'I have a Python agent',
    blurb:  'Anthropic, OpenAI, LangChain, CrewAI, LlamaIndex, Bedrock, Gemini, Mistral, smolagents — one import covers all of them.',
    icon: Code2,
    tag:   'pip install',
  },
  {
    id: 'javascript',
    title: 'I have a JS / TS agent',
    blurb:  'OpenAI, Anthropic, Vercel AI SDK, Mastra — same one-line idea, in TypeScript.',
    icon: FileCode2,
    tag:   'npm install',
  },
  {
    id: 'demo',
    title: 'I don\'t have an agent yet',
    blurb:  'Run our 60-second demo agent against the gateway. It makes a realistic mix of safe and risky tool calls so you can see every panel light up.',
    icon: PlayCircle,
    tag:   'no-code',
  },
  {
    id: 'proxy',
    title: 'I use OpenAI / Anthropic over HTTP',
    blurb:  'Point your existing client base_url at our LLM Egress Proxy — no SDK install required. Works for any language.',
    icon: Terminal,
    tag:   'drop-in proxy',
  },
]

export function ScenarioPicker({ onPick }: { onPick: (id: ScenarioId) => void }) {
  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1
          className="text-3xl md:text-4xl leading-tight"
          style={{ fontFamily: 'var(--font-serif), ui-serif, Georgia, serif', color: TEXT, letterSpacing: '-0.012em' }}
        >
          Let's get your first agent <em style={{ fontStyle: 'italic' }}>under guard</em>.
        </h1>
        <p className="text-base max-w-2xl" style={{ color: MUTED }}>
          Pick the path that matches what you already have. Each one takes about a minute.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {SCENARIOS.map(s => {
          const Icon = s.icon
          return (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className="text-left rounded-md p-4 transition-colors group"
              style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = PRIMARY }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = BORDER }}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className="h-4 w-4" style={{ color: TEXT }} />
                <h2 className="text-[15px] font-medium" style={{ color: TEXT }}>{s.title}</h2>
                <span
                  className="ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-mono"
                  style={{ background: 'hsl(var(--background))', color: MUTED, border: `1px solid ${BORDER}` }}
                >
                  {s.tag}
                </span>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: MUTED }}>{s.blurb}</p>
            </button>
          )
        })}
      </div>
    </section>
  )
}
