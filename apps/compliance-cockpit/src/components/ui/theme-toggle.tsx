'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'

type Mode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'aegis:theme'

function readStored(): Mode {
  if (typeof window === 'undefined') return 'system'
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

function apply(mode: Mode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  if (mode === 'system') return
  root.classList.add(mode)
}

/**
 * Three-state theme switch (light / system / dark). The system state
 * means "follow the OS preference"; the other two override it. The
 * CSS variables in globals.css already react to a `.dark` class on
 * <html>, so all this component does is toggle the class and stash
 * the preference in localStorage so subsequent loads remember.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('system')

  // Hydrate from storage on mount. Apply unconditionally — the CSS
  // already defaults to the OS preference via @media when no class
  // is set, so an explicit 'system' is a no-op here too.
  useEffect(() => {
    const stored = readStored()
    setMode(stored)
    apply(stored)
  }, [])

  const choose = (next: Mode) => {
    setMode(next)
    apply(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* third-party cookies blocked — silently fall back to in-memory */
    }
  }

  const BORDER = 'hsl(var(--border))'
  const ACTIVE = 'hsl(var(--accent))'
  const TEXT   = 'hsl(var(--foreground))'
  const MUTED  = 'hsl(var(--muted-foreground))'

  const opts: { value: Mode; icon: typeof Sun; label: string }[] = [
    { value: 'light',  icon: Sun,     label: 'Light'  },
    { value: 'system', icon: Monitor, label: 'System' },
    { value: 'dark',   icon: Moon,    label: 'Dark'   },
  ]

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-1 p-0.5 rounded"
      style={{ border: `1px solid ${BORDER}` }}
    >
      {opts.map((o) => {
        const Icon = o.icon
        const active = mode === o.value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => choose(o.value)}
            className="flex-1 flex items-center justify-center py-1 rounded transition-colors"
            style={{
              background: active ? ACTIVE : 'transparent',
              color: active ? TEXT : MUTED,
            }}
          >
            <Icon className="h-3 w-3" />
          </button>
        )
      })}
    </div>
  )
}
