import { NextRequest } from 'next/server'

const BASE = process.env['GATEWAY_URL'] || 'http://localhost:8080'

export const dynamic = 'force-dynamic'

let _cachedKey: string | null = null

async function resolveKey(req: NextRequest): Promise<string> {
  if (process.env['GATEWAY_API_KEY']) return process.env['GATEWAY_API_KEY']!
  const fromClient = req.headers.get('x-api-key')
  if (fromClient) return fromClient
  if (_cachedKey) return _cachedKey
  try {
    const r = await fetch(`${BASE}/api/v1/auth/key`, { cache: 'no-store' })
    if (r.ok) {
      const data = await r.json()
      if (data.api_key) { _cachedKey = data.api_key; return _cachedKey! }
    }
  } catch { /* gateway unreachable */ }
  return ''
}

/**
 * Streaming proxy for the gateway's onboarding SSE endpoint. We can't
 * use the generic [...path] gateway proxy because that one buffers JSON;
 * SSE must be streamed byte-for-byte so the wizard sees events live.
 */
export async function GET(request: NextRequest) {
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  const bearer = request.headers.get('authorization')
  if (bearer && bearer.startsWith('Bearer ')) headers['authorization'] = bearer
  const key = await resolveKey(request)
  if (key) headers['x-api-key'] = key

  const upstream = await fetch(`${BASE}/api/v1/onboarding/stream`, {
    headers,
    cache: 'no-store',
  })

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: 'Gateway unreachable' }), {
      status: upstream.status || 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Pass-through stream. AbortController hooks our client-disconnect to
  // the upstream so the gateway's SSE writer can clean up its listener
  // and heartbeat timer.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
