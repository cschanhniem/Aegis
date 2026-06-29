/**
 * Turn a raw trace into a 1-line, plain-English description that names
 * the SPECIFIC counterparty / target where possible.
 *
 *   send_email   { to: 'alice@gmail.com' }
 *       → 'Emailed alice@gmail.com'
 *   web_search   { query: 'top ml libs', engine: 'google' }
 *       → 'Searched Google for "top ml libs"'
 *   db_query     { table: 'users', op: 'SELECT' }
 *       → 'Queried users'
 *   stripe_charge { amount: 4700 }
 *       → 'Charged $47.00 via Stripe'
 *   http_post    { url: 'https://api.openai.com/v1/...' }
 *       → 'POST api.openai.com'
 *
 * Same trace-shape contract the existing traceSummary() lib uses, but
 * with brand recognition + recipient naming.
 */

type Args = Record<string, any>

export interface RichActivity {
  /** Plain-English sentence to render in the row. */
  text: string
  /** Identifier the icon resolver can use — overrides the raw tool_name.
   *  e.g. 'gmail_send' so ToolIcon renders Gmail mark instead of generic email. */
  iconKey?: string
  /** If the action targets a known email recipient, this is the address.
   *  Lets the row optionally show a Gravatar. */
  recipientEmail?: string
  /** Recipient website (for HTTP / web_search), used for favicon. */
  recipientHost?: string
}

/** Normalize an args bag into the most likely "primary target string". */
function pickTarget(args: Args): string | null {
  for (const k of ['to', 'recipient', 'address', 'email', 'destination']) {
    if (typeof args[k] === 'string') return args[k]
  }
  return null
}

/** Domain → brand-icon key. */
const EMAIL_DOMAIN_BRAND: Record<string, string> = {
  'gmail.com':       'gmail',
  'googlemail.com':  'gmail',
  'outlook.com':     'outlook',
  'hotmail.com':     'outlook',
  'live.com':        'outlook',
  'icloud.com':      'icloud',
  'me.com':          'icloud',
  'protonmail.com':  'proton',
  'proton.me':       'proton',
}

const HOST_BRAND: Record<string, string> = {
  'google.com':            'google',
  'www.google.com':        'google',
  'github.com':            'github',
  'api.github.com':        'github',
  'api.stripe.com':        'stripe',
  'api.slack.com':         'slack',
  'hooks.slack.com':       'slack',
  'api.notion.com':        'notion',
  'api.openai.com':        'openai',
  'api.anthropic.com':     'anthropic',
  's3.amazonaws.com':      'aws',
  'api.vercel.com':        'vercel',
  'api.cloudflare.com':    'cloudflare',
  'api.supabase.io':       'supabase',
  'firebaseio.com':        'firebase',
  'api.twilio.com':        'twilio',
  'api.sendgrid.com':      'sendgrid',
  'api.linear.app':        'linear',
  'api.atlassian.com':     'jira',
  'api.hubapi.com':        'hubspot',
  'api.datadoghq.com':     'datadog',
  'hub.docker.com':        'docker',
}

function brandForEmail(addr: string): string | null {
  const domain = addr.split('@')[1]?.toLowerCase()
  if (!domain) return null
  return EMAIL_DOMAIN_BRAND[domain] ?? null
}

function brandForHost(host: string): string | null {
  if (HOST_BRAND[host]) return HOST_BRAND[host]
  // Wildcard-y fallbacks
  if (host.endsWith('.amazonaws.com')) return 'aws'
  if (host.endsWith('.slack.com'))     return 'slack'
  if (host.endsWith('.openai.com'))    return 'openai'
  if (host.endsWith('.anthropic.com')) return 'anthropic'
  return null
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try { return new URL(url).host } catch { return null }
}

function truncate(s: string, n = 40): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/** Map a search-engine hint to a display name + brand key. */
function searchEngine(args: Args): { name: string; brand: string } | null {
  const e = (args.engine ?? args.provider ?? '').toString().toLowerCase()
  if (e === 'google' || (args.url ?? '').includes('google.com')) return { name: 'Google',     brand: 'google' }
  if (e === 'bing'   || (args.url ?? '').includes('bing.com'))   return { name: 'Bing',       brand: 'bing' }
  if (e === 'ddg'    || (args.url ?? '').includes('duckduckgo')) return { name: 'DuckDuckGo', brand: 'duckduckgo' }
  if (e === 'perplexity')                                         return { name: 'Perplexity', brand: 'perplexity' }
  if (e === 'brave')                                              return { name: 'Brave',      brand: 'brave' }
  return null
}

export function describeActivity(trace: any): RichActivity {
  const tool = (trace.tool_call?.tool_name ?? '').toLowerCase()
  const args: Args = trace.tool_call?.arguments ?? {}

  // ── EMAIL ────────────────────────────────────────────────────────
  if (/email|mail|smtp/.test(tool)) {
    const to = pickTarget(args)
    if (to) {
      const brand = brandForEmail(to)
      return {
        text: `Emailed ${to}`,
        recipientEmail: to,
        iconKey: brand ? `${brand}_send` : tool,
      }
    }
    return { text: 'Sent an email', iconKey: tool }
  }

  // ── WEB SEARCH ──────────────────────────────────────────────────
  if (/search|lookup/.test(tool)) {
    const engine = searchEngine(args)
    const q = args.query ?? args.q ?? args.search ?? ''
    const target = engine
      ? `${engine.name} for "${truncate(String(q), 30)}"`
      : `for "${truncate(String(q), 40)}"`
    return {
      text: `Searched ${target}`,
      iconKey: engine ? `${engine.brand}_search` : tool,
    }
  }

  // ── HTTP / fetch ─────────────────────────────────────────────────
  if (/http|fetch|request|webhook/.test(tool)) {
    const url = args.url ?? args.endpoint ?? ''
    const host = hostOf(url)
    const brand = host ? brandForHost(host) : null
    const verb = tool.includes('post') ? 'POSTed' : tool.includes('put') ? 'PUT' : 'Fetched'
    return {
      text: host ? `${verb} ${host}` : `${verb} ${truncate(String(url), 50)}`,
      recipientHost: host ?? undefined,
      iconKey: brand ? `${brand}_http` : tool,
    }
  }

  // ── DB ───────────────────────────────────────────────────────────
  if (/sql|query|db|database/.test(tool)) {
    const table = (args.sql ?? args.query ?? '').match(/FROM\s+([a-z0-9_]+)/i)?.[1]
      ?? args.table ?? null
    if (table) return { text: `Queried ${table}`, iconKey: tool }
    return { text: 'Ran a database query', iconKey: tool }
  }

  // ── SHELL ────────────────────────────────────────────────────────
  if (/shell|bash|run_cmd|execute_(?:code|cmd|shell)|spawn/.test(tool)) {
    const cmd = args.command ?? args.cmd ?? ''
    return {
      text: cmd ? `Ran ${truncate(String(cmd), 50)}` : 'Ran a shell command',
      iconKey: tool,
    }
  }

  // ── FILE OPS ─────────────────────────────────────────────────────
  if (/write|append|put_(?:file|object)|upload|save/.test(tool)) {
    const path = args.path ?? args.file_path ?? args.filename ?? args.key ?? ''
    return { text: path ? `Wrote ${truncate(String(path), 45)}` : 'Wrote a file', iconKey: tool }
  }
  if (/^delete|rm$|unlink/.test(tool)) {
    const path = args.path ?? args.file_path ?? args.filename ?? args.key ?? ''
    return { text: path ? `Deleted ${truncate(String(path), 45)}` : 'Deleted a file', iconKey: tool }
  }
  if (/read|cat|head|tail|get_(?:file|object)|fetch_file/.test(tool)) {
    const path = args.path ?? args.file_path ?? args.filename ?? args.key ?? ''
    return { text: path ? `Read ${truncate(String(path), 45)}` : 'Read a file', iconKey: tool }
  }

  // ── PAYMENT ──────────────────────────────────────────────────────
  if (/stripe|charge|payment|refund|transfer/.test(tool)) {
    const amt = args.amount_cents ?? args.amount ?? null
    const usd = typeof amt === 'number'
      ? (amt > 999 ? `$${(amt / 100).toFixed(2)}` : `$${amt}`)
      : null
    const action = /refund/.test(tool) ? 'Refunded' : /transfer/.test(tool) ? 'Transferred' : 'Charged'
    return {
      text: usd ? `${action} ${usd}` : `${action} via Stripe`,
      iconKey: tool.includes('stripe') ? tool : 'stripe_charge',
    }
  }

  // ── FALLBACK ─────────────────────────────────────────────────────
  return { text: tool.replace(/_/g, ' '), iconKey: tool }
}
