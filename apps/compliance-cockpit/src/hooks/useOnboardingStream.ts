'use client'

import { useEffect, useRef, useState } from 'react'
import { getApiKey, getSessionToken } from '@/lib/gateway'

export interface OnboardingEvent {
  event: string
  data: any
}

/**
 * Subscribes to /api/onboarding-stream and surfaces each parsed SSE
 * event. Uses fetch + ReadableStream (not EventSource) so the request
 * carries the Bearer / X-API-Key headers the gateway requires.
 *
 * Reconnects with exponential backoff on disconnect. `connectionState`
 * tells the UI when the stream is live vs. recovering.
 */
export function useOnboardingStream(opts: { enabled?: boolean } = {}): {
  events: OnboardingEvent[]
  connectionState: 'idle' | 'opening' | 'open' | 'reconnecting' | 'closed'
} {
  const enabled = opts.enabled ?? true
  const [events, setEvents] = useState<OnboardingEvent[]>([])
  const [connectionState, setConnectionState] = useState<'idle' | 'opening' | 'open' | 'reconnecting' | 'closed'>('idle')
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    cancelledRef.current = false
    let abort: AbortController | null = null
    let backoffMs = 750

    const connect = async () => {
      if (cancelledRef.current) return
      setConnectionState(prev => (prev === 'open' || prev === 'opening' ? prev : 'opening'))

      abort = new AbortController()
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      const session = getSessionToken()
      const apiKey  = getApiKey()
      if (session) headers['authorization'] = `Bearer ${session}`
      if (apiKey)  headers['x-api-key']     = apiKey

      let res: Response
      try {
        res = await fetch('/api/onboarding-stream', { headers, signal: abort.signal, cache: 'no-store' })
      } catch (err) {
        if (cancelledRef.current) return
        setConnectionState('reconnecting')
        await delay(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 15_000)
        return connect()
      }
      if (!res.ok || !res.body) {
        setConnectionState('reconnecting')
        await delay(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 15_000)
        return connect()
      }
      setConnectionState('open')
      backoffMs = 750

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (!cancelledRef.current) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const parsed = parseSseChunk(chunk)
            if (parsed) setEvents(prev => [...prev, parsed])
          }
        }
      } catch (err) {
        // Stream ended unexpectedly. Fall through to reconnect.
      }
      if (cancelledRef.current) return
      setConnectionState('reconnecting')
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 15_000)
      return connect()
    }

    connect()
    return () => {
      cancelledRef.current = true
      setConnectionState('closed')
      try { abort?.abort() } catch {}
    }
  }, [enabled])

  return { events, connectionState }
}

function parseSseChunk(chunk: string): OnboardingEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  try { return { event, data: JSON.parse(raw) } }
  catch { return { event, data: raw } }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
