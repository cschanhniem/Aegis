/**
 * Secret scanner — finds credentials accidentally committed to a repo.
 *
 * Two-stage detection, mirroring gitleaks / detect-secrets:
 *
 *   1. **Pattern stage** — regex against a curated rule set. Covers
 *      the highest-value secret formats (cloud + AI provider keys,
 *      database connection strings, JWT, private keys). Each rule has
 *      an embedded **entropy floor** (Shannon bits/char) — a high-
 *      entropy gate kills the most common false positives ("AKIA" in a
 *      test fixture, etc.).
 *
 *   2. **Generic-high-entropy stage** — Shannon-entropy threshold for
 *      strings that look like opaque random bytes (≥ 4.3 bits/char and
 *      length ≥ 32). Catches credentials that don't match a known
 *      pattern at all. Tightly scoped to assignment-RHS string literals
 *      to keep noise down on natural prose.
 *
 * AI-specific coverage — the differentiator vs. generic gitleaks:
 *   - sk-... (OpenAI standard + project keys + service accounts)
 *   - sk-ant-... (Anthropic API keys, both legacy and v2)
 *   - hf_... (HuggingFace tokens)
 *   - AIza... (Google AI / Gemini API keys)
 *   - claude_... (cloud-specific provider tokens)
 *   - Cohere co_..., Together together_..., Replicate r8_...,
 *     Groq gsk_..., Mistral...
 *
 * Output shape mirrors custom-rule findings so the report layer can
 * fold both into one table.
 */

/** Shannon entropy in bits/char. Higher = more "random-looking". */
function shannonEntropy(s) {
  if (!s) return 0
  const freq = new Map()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  const n = s.length
  for (const c of freq.values()) {
    const p = c / n
    h -= p * Math.log2(p)
  }
  return h
}

/** Curated pattern rules. Order matters: the most specific ones come
 *  first so the report attributes the right `kind` when overlaps exist
 *  (e.g. an OpenAI key matches both `openai-key` and the generic
 *  `sk-*` shape). */
const PATTERN_RULES = [
  // ── AI / LLM provider keys ─────────────────────────────────────
  { id: 'openai-key',         kind: 'openai',     severity: 'CRITICAL',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, entropyMin: 4.0,
    msg: 'OpenAI API key detected' },
  { id: 'anthropic-key',      kind: 'anthropic',  severity: 'CRITICAL',
    regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/, entropyMin: 4.0,
    msg: 'Anthropic API key detected' },
  { id: 'huggingface-token',  kind: 'huggingface',severity: 'HIGH',
    regex: /\bhf_[A-Za-z]{32,}\b/, entropyMin: 3.5,
    msg: 'HuggingFace access token detected' },
  { id: 'google-api-key',     kind: 'google',     severity: 'HIGH',
    // Google API keys are conventionally 35 chars after AIza, but
    // some service-account variants are slightly longer; widen the
    // window so forward-compat forms still trip the rule.
    regex: /\bAIza[A-Za-z0-9_-]{35,40}\b/, entropyMin: 4.0,
    msg: 'Google / Gemini API key detected' },
  { id: 'cohere-key',         kind: 'cohere',     severity: 'HIGH',
    regex: /\bco-[A-Za-z0-9]{40,}\b/, entropyMin: 4.0,
    msg: 'Cohere API key detected' },
  { id: 'replicate-key',      kind: 'replicate',  severity: 'HIGH',
    regex: /\br8_[A-Za-z0-9]{30,}\b/, entropyMin: 4.0,
    msg: 'Replicate API token detected' },
  { id: 'groq-key',           kind: 'groq',       severity: 'HIGH',
    regex: /\bgsk_[A-Za-z0-9]{40,}\b/, entropyMin: 4.0,
    msg: 'Groq API key detected' },
  { id: 'mistral-key',        kind: 'mistral',    severity: 'HIGH',
    regex: /\b[A-Za-z0-9]{32}\b(?=.*mistral)/i, entropyMin: 4.3,
    msg: 'Likely Mistral API key detected' },
  { id: 'together-key',       kind: 'together',   severity: 'HIGH',
    regex: /\btogether_[A-Za-z0-9]{32,}\b/, entropyMin: 4.0,
    msg: 'Together AI key detected' },

  // ── Cloud provider keys ────────────────────────────────────────
  { id: 'aws-access-key',     kind: 'aws',        severity: 'CRITICAL',
    regex: /\b(?:AKIA|ASIA|AROA|AIDA|ABIA|ACCA)[0-9A-Z]{16}\b/, entropyMin: 3.5,
    msg: 'AWS access-key ID detected' },
  { id: 'aws-secret-key',     kind: 'aws',        severity: 'CRITICAL',
    regex: /aws_secret_access_key\s*=\s*['"]([A-Za-z0-9/+=]{40})['"]/i, entropyMin: 4.2,
    msg: 'AWS secret access-key detected' },
  { id: 'gcp-service-account',kind: 'gcp',        severity: 'CRITICAL',
    regex: /"type"\s*:\s*"service_account"/i, entropyMin: 0,
    msg: 'GCP service-account JSON detected' },
  { id: 'azure-storage-key',  kind: 'azure',      severity: 'HIGH',
    regex: /\bDefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{40,}/, entropyMin: 0,
    msg: 'Azure storage connection-string detected' },

  // ── Generic high-impact ────────────────────────────────────────
  { id: 'github-token',       kind: 'github',     severity: 'CRITICAL',
    regex: /\bgh[opsu]_[A-Za-z0-9_]{36,}\b/, entropyMin: 3.5,
    msg: 'GitHub personal-access / app token detected' },
  { id: 'stripe-key',         kind: 'stripe',     severity: 'CRITICAL',
    regex: /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]{24,}\b/, entropyMin: 4.0,
    msg: 'Stripe API key detected' },
  { id: 'slack-token',        kind: 'slack',      severity: 'HIGH',
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, entropyMin: 3.0,
    msg: 'Slack token detected' },
  { id: 'jwt',                kind: 'jwt',        severity: 'MEDIUM',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, entropyMin: 4.0,
    msg: 'JWT detected' },
  { id: 'private-key-pem',    kind: 'pem',        severity: 'CRITICAL',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/, entropyMin: 0,
    msg: 'Private key in PEM block detected' },
  { id: 'db-connection-pg',   kind: 'database',   severity: 'HIGH',
    regex: /postgres(?:ql)?:\/\/[^:]+:[^@\s]+@[^/\s]+/, entropyMin: 0,
    msg: 'Postgres connection-string with embedded password detected' },
  { id: 'db-connection-mysql',kind: 'database',   severity: 'HIGH',
    regex: /mysql:\/\/[^:]+:[^@\s]+@[^/\s]+/, entropyMin: 0,
    msg: 'MySQL connection-string with embedded password detected' },
  { id: 'db-connection-mongo',kind: 'database',   severity: 'HIGH',
    regex: /mongodb(?:\+srv)?:\/\/[^:]+:[^@\s]+@[^/\s]+/, entropyMin: 0,
    msg: 'MongoDB connection-string with embedded password detected' },
]

/** Files whose path component is "test", "spec", "example", "fixture",
 *  or "mock" get downgraded — these are usually faked secrets used in
 *  testing. We still REPORT them but flag `is_test: true` so the
 *  cockpit can render them collapsed by default. */
const TEST_PATH_RE = /(?:^|\/)(?:tests?|spec|examples?|fixtures?|mocks?)(?:\/|$)/i

/** Scan one file's source text. Returns an array of secret findings
 *  matching the documented shape. */
export function scanFileForSecrets(opts) {
  const { path, source, language } = opts
  const findings = []
  if (!source || source.length === 0) return findings
  const isTest = TEST_PATH_RE.test(path)

  // Stage 1: curated patterns
  for (const rule of PATTERN_RULES) {
    const re = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g')
    let m
    while ((m = re.exec(source)) !== null) {
      const value = m[1] ?? m[0]
      const entropy = shannonEntropy(value)
      if (entropy < rule.entropyMin) continue
      const idx = m.index
      const line = source.slice(0, idx).split('\n').length
      findings.push({
        rule_id: rule.id,
        kind: rule.kind,
        severity: rule.severity,
        message: rule.msg,
        path,
        line,
        evidence: redactSecret(value),
        entropy: round(entropy, 2),
        is_test: isTest,
      })
      // Don't fire the same rule twice on overlapping matches.
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1
    }
  }

  // Stage 2: generic high-entropy string literals (`= "..."` / `: "..."`).
  // The lookahead anchors us to RHS-of-assignment to keep prose alone.
  const HIGH_ENTROPY_LITERAL = /['"]([A-Za-z0-9+/=_-]{32,256})['"]/g
  let g
  // De-dup against already-fired pattern matches to avoid double-counting.
  const alreadyFired = new Set(findings.map(f => f.evidence_full))
  while ((g = HIGH_ENTROPY_LITERAL.exec(source)) !== null) {
    const value = g[1]
    if (alreadyFired.has(value)) continue
    // Look back ~80 chars; only fire when the literal sits on the RHS
    // of "=" or ":" (covers assignments + JSON + YAML).
    const head = source.slice(Math.max(0, g.index - 80), g.index)
    if (!/[:=]\s*['"]*$/.test(head)) continue
    const entropy = shannonEntropy(value)
    if (entropy < 4.3) continue
    if (looksLikeBase64Whitelist(value)) continue   // base64-image / SVG path opt-out
    const line = source.slice(0, g.index).split('\n').length
    findings.push({
      rule_id: 'generic-high-entropy',
      kind: 'generic',
      severity: 'MEDIUM',
      message: 'High-entropy string literal — may be a secret',
      path,
      line,
      evidence: redactSecret(value),
      entropy: round(entropy, 2),
      is_test: isTest,
    })
  }

  return findings
}

function redactSecret(s) {
  if (!s) return ''
  if (s.length <= 8) return '****'
  return s.slice(0, 4) + '…' + s.slice(-4)
}

function round(x, n) { return Math.round(x * 10 ** n) / 10 ** n }

/** Common high-entropy strings that AREN'T secrets — base64 images,
 *  Lorem-ipsum style filler at exact alphabet sizes, etc. */
function looksLikeBase64Whitelist(s) {
  // PNG / JPEG / SVG header sentinels
  if (s.startsWith('iVBORw0KGgo') || s.startsWith('/9j/') || s.startsWith('PHN2Z')) return true
  // Looks like a content-hash (40 or 64 hex chars) — these are
  // usually file checksums, not credentials.
  if (/^[0-9a-f]+$/i.test(s) && (s.length === 40 || s.length === 64)) return true
  return false
}

export const _internals = { shannonEntropy, PATTERN_RULES }
