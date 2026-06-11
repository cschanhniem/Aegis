/**
 * Curated few-shot exemplars for the NL → policy bundle generator.
 *
 * StructuredRAG (arXiv 2408.11061) showed retrieval-augmented exemplars
 * lift structured-output success ~15-20 points over zero-shot. We don't
 * yet have a vector store of past operator-approved bundles, so this
 * file ships hand-curated examples that cover three archetypes:
 *
 *   (a) solo-dev / personal automation — tight, small bundle
 *   (b) team-built CRM-like agent — moderate complexity, owner email
 *   (c) regulated-sector copilot — strict schemas + DSL for sensitive ops
 *
 * Each example shows the full I/O including the `reasoning` field
 * that the model must emit FIRST — this is the Instructor-blog
 * "reasoning-first" pattern (it primes the model to *plan* before
 * generating the structured payload).
 */

export interface PolicyExample {
  description: string
  context?: Record<string, unknown>
  /** Raw JSON string the model should output. Pre-canonicalised — no
   *  whitespace games — so it doesn't waste tokens. */
  output: string
}

export const FEW_SHOT_EXAMPLES: PolicyExample[] = [
  // (a) Solo developer — small, decisive
  {
    description: "It's a Telegram bot for my homelab that reads my notes folder and posts summaries. Block any shell call, block file writes outside /home/me/notes, block any HTTP request that's not to localhost.",
    output: JSON.stringify({
      reasoning: "Single-user, no review queue, so prefer block over pending. Three concrete constraints map to three schemas: shell tools must be impossible (DSL block), file_write must whitelist path prefix, and http_get/fetch must constrain url. DSL adds a defensive rule on classifier.category=='shell'.",
      policies: [
        {
          id: 'no-shell',
          name: 'No Shell',
          description: 'Forbid shell command execution.',
          risk_level: 'HIGH',
          policy_schema: { type: 'object', properties: { command: { type: 'string', maxLength: 0 } }, additionalProperties: true },
          tests: {
            should_block: [
              { tool: 'shell', arguments: { command: 'ls -la' } },
              { tool: 'shell', arguments: { command: 'rm -rf /' } },
            ],
            should_allow: [],
          },
        },
        {
          id: 'notes-only-write',
          name: 'Restrict writes to notes folder',
          description: 'file_write path must start with /home/me/notes.',
          risk_level: 'MEDIUM',
          policy_schema: { type: 'object', properties: { path: { type: 'string', pattern: '^/home/me/notes(/|$)' } }, additionalProperties: true },
          tests: {
            should_block: [
              { tool: 'file_write', arguments: { path: '/etc/passwd', content: 'x' } },
              { tool: 'file_write', arguments: { path: '/tmp/foo', content: 'x' } },
            ],
            should_allow: [
              { tool: 'file_write', arguments: { path: '/home/me/notes/2026-06.md', content: 'x' } },
            ],
          },
        },
        {
          id: 'localhost-only-http',
          name: 'Outbound HTTP localhost only',
          description: 'http_get / fetch URL must point at localhost / 127.0.0.1.',
          risk_level: 'HIGH',
          policy_schema: { type: 'object', properties: { url: { type: 'string', pattern: '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?(/|$)' } }, additionalProperties: true },
          tests: {
            should_block: [
              { tool: 'http_get', arguments: { url: 'https://api.evil.com/x' } },
            ],
            should_allow: [
              { tool: 'http_get', arguments: { url: 'http://localhost:8000/notes' } },
            ],
          },
        },
      ],
      dsl: {
        version: 1,
        rules: [
          { name: 'block-shell-category', when: { 'classifier.category': 'shell' }, then: { decision: 'block', reason: 'shell disallowed by config' } },
        ],
      },
    }),
  },

  // (b) Team / CRM copilot
  {
    description: "Our sales copilot reads Salesforce records and drafts follow-up emails. Block deletion of any record, block any email recipient outside our company domain example.com, require human review for sends to more than 10 recipients.",
    output: JSON.stringify({
      reasoning: "Team setting with review capacity — use pending for ambiguous cases (bulk sends), block on hard violations. Three policies: salesforce_delete schema rejects all (it must never delete); send_email constrains to.endsWith('@example.com'); DSL adds a pending rule when recipient count > 10.",
      policies: [
        {
          id: 'no-salesforce-delete',
          name: 'No CRM deletes',
          description: 'salesforce_delete is unconditionally blocked.',
          risk_level: 'CRITICAL',
          policy_schema: { type: 'object', properties: { record_id: { type: 'string', maxLength: 0 } }, additionalProperties: true },
          tests: {
            should_block: [
              { tool: 'salesforce_delete', arguments: { record_id: '003xx' } },
            ],
            should_allow: [],
          },
        },
        {
          id: 'email-domain-allowlist',
          name: 'Email recipients must be on example.com',
          description: 'Block sends to addresses outside the company domain.',
          risk_level: 'HIGH',
          policy_schema: { type: 'object', properties: { to: { type: 'string', pattern: '^[^@\\s]+@example\\.com$' } }, additionalProperties: true },
          tests: {
            should_block: [
              { tool: 'send_email', arguments: { to: 'attacker@evil.com', subject: 'x', body: 'y' } },
            ],
            should_allow: [
              { tool: 'send_email', arguments: { to: 'colleague@example.com', subject: 'x', body: 'y' } },
            ],
          },
        },
      ],
      dsl: {
        version: 1,
        rules: [
          { name: 'pending-bulk-send', when: { all: [ { 'tool.name': 'send_email' }, { 'tool.args.recipient_count': { '>': 10 } } ] }, then: { decision: 'pending', reason: 'bulk send needs human approval' } },
        ],
      },
    }),
  },

  // (c) Template-form — canonical shape using the constrained grammar.
  // Mirrors example (a) but in the preferred form so the model sees how
  // the same intent maps onto templates.
  {
    description: "I'm building a webhook receiver that forwards events to a downstream HTTPS API. The forwarder should only ever POST to https://hooks.example.com/, the payload size must be under 4KB, and it must never carry a raw 'password' field.",
    output: JSON.stringify({
      reasoning: "Three concrete constraints map 1:1 onto templates: (1) destination URL whitelist → require_pattern, (2) payload size cap → max_length, (3) sensitive field denylist → forbid_argument. No tenant-mode logic needed, so DSL stays minimal.",
      policies: [
        {
          id: 'webhook-https-target',
          name: 'Webhook target must be hooks.example.com',
          description: 'Only the production webhook host is allowed.',
          risk_level: 'HIGH',
          template: { kind: 'require_pattern', field: 'url', pattern: '^https://hooks\\.example\\.com/' },
          tests: {
            should_block: [
              { tool: 'http_post', arguments: { url: 'https://attacker.example.org/x', body: '{}' } },
              { tool: 'http_post', arguments: { url: 'http://hooks.example.com/x', body: '{}' } },
            ],
            should_allow: [
              { tool: 'http_post', arguments: { url: 'https://hooks.example.com/v1/events', body: '{}' } },
            ],
          },
        },
        {
          id: 'webhook-body-cap',
          name: 'Webhook payload ≤ 4KB',
          description: 'Bound the forwarded body to prevent abuse.',
          risk_level: 'MEDIUM',
          template: { kind: 'max_length', field: 'body', max: 4096 },
          tests: {
            should_block: [
              { tool: 'http_post', arguments: { body: 'x'.repeat(5000) } },
            ],
            should_allow: [
              { tool: 'http_post', arguments: { body: '{"id":1}' } },
            ],
          },
        },
        {
          id: 'no-password-field',
          name: 'No password field in payload',
          description: 'Refuse any call carrying a literal password argument.',
          risk_level: 'CRITICAL',
          template: { kind: 'forbid_argument', field: 'password' },
          tests: {
            should_block: [
              { tool: 'http_post', arguments: { password: 'secret' } },
            ],
            should_allow: [
              { tool: 'http_post', arguments: { user: 'alice' } },
            ],
          },
        },
      ],
      dsl: {
        version: 1,
        rules: [
          { name: 'pending-high-anomaly', when: { 'anomaly.score': { '>': 0.7 } }, then: { decision: 'pending', reason: 'anomalous webhook target — review' } },
        ],
      },
    }),
  },
]

/**
 * Pick the most-similar exemplars from the bank using a cheap lexical
 * signal (word overlap with the user description). We avoid a vector
 * store dependency by exploiting that the bank is small and the user
 * description is short — Jaccard on lower-cased word tokens is good
 * enough to surface "your case looks like (a)" without an embedding
 * model.
 */
export function pickExemplars(description: string, k = 2): PolicyExample[] {
  const tokens = (s: string) => new Set(
    s.toLowerCase().split(/[^a-z]+/).filter(t => t.length > 3)
  )
  const target = tokens(description)
  const scored = FEW_SHOT_EXAMPLES.map(ex => {
    const exTokens = tokens(ex.description)
    let intersection = 0
    target.forEach(t => { if (exTokens.has(t)) intersection++ })
    const union = target.size + exTokens.size - intersection
    return { ex, score: union > 0 ? intersection / union : 0 }
  })
  return scored.sort((a, b) => b.score - a.score).slice(0, k).map(s => s.ex)
}
