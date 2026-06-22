/**
 * Authenticated gateway proxy.
 *
 * `https://app.aegis.dev/api/gw/<path>` →
 *   reads X-API-Key from client → resolves to orgId via hosted_api_keys
 *   → proxies to internal gateway with `X-Org-Id: <uuid>` injected
 *   + the original headers stripped of the API key (gateway sees an
 *   already-authenticated, tenant-scoped request).
 *
 * Used by:
 *   • the cockpit (browser) for every /api/gateway/... call
 *   • SDKs that point at https://gw.aegis.dev (which is just a CNAME
 *     to this app's gateway proxy)
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateApiKey } from '@/lib/tenant'

export const runtime = 'nodejs'

const GATEWAY_URL = process.env.GATEWAY_INTERNAL_URL ?? 'http://localhost:8080'

async function handle(req: NextRequest, { params }: { params: { path: string[] } }) {
  const auth = req.headers.get('x-api-key') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!auth) return NextResponse.json({ error: 'missing api key' }, { status: 401 })

  const session = await authenticateApiKey(auth)
  if (!session) return NextResponse.json({ error: 'invalid api key' }, { status: 401 })

  const url = `${GATEWAY_URL}/api/v1/${params.path.join('/')}${req.nextUrl.search}`
  const headers = new Headers(req.headers)
  headers.delete('x-api-key')
  headers.delete('authorization')
  headers.set('x-org-id', session.orgId)
  // The gateway trusts X-Org-Id only when the request is signed by the
  // internal admin key. The control plane holds that key and adds it
  // here so the gateway knows the X-Org-Id is authoritative.
  if (process.env.GATEWAY_ADMIN_KEY) {
    headers.set('x-internal-admin-key', process.env.GATEWAY_ADMIN_KEY)
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
  })

  // Stream the response body back.
  const resHeaders = new Headers(upstream.headers)
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  })
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE }
