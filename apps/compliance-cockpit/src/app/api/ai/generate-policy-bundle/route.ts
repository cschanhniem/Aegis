/**
 * NL → policy + DSL bundle generator (frontier-aligned).
 *
 * What changed in this revision (over the previous validator-in-loop):
 *
 *   1. REASONING-FIRST schema (Instructor blog, Sept 2024): the model
 *      emits a `reasoning` string FIRST in the JSON. Empirically a
 *      large quality lift on schema-grounded tasks — the model plans
 *      before it serializes.
 *
 *   2. SELF-CONSISTENCY (Wang 2023; ranked voting ACL 2025): sample
 *      N=3 outputs at temperature 0.7 in parallel. The validator
 *      scores each (AJV compile + run model-emitted self-tests). The
 *      highest-scoring bundle wins.
 *
 *   3. EXEMPLAR RAG (StructuredRAG, arXiv 2408.11061): pick the
 *      2 most-similar curated examples and prepend them to the
 *      user prompt as a few-shot transcript.
 *
 *   4. CRITIQUE + REFINE round: if no sample reaches ok=true, the
 *      best-of-N is fed into ONE targeted repair round (PerFine
 *      arXiv 2510.24469 pattern — generator + critic split). We
 *      capped at one repair round because the N-sample diversity
 *      already does most of the work.
 *
 * Net effect: validator pass rate measurably higher in dogfood,
 * fewer retry rounds in steady state, total LLM-call cost ~3-4x
 * the old single-shot path but consistently produces a usable
 * bundle on the first round instead of "best partial".
 */

import { NextRequest, NextResponse } from 'next/server'
import { validateBundle as runValidator, Bundle, ValidationReport as ValidatorReport } from '@/lib/policy-validator'
import { analyzeWorkflowGap, ToolInventoryEntry } from '@/lib/workflow-gap'
import { pickExemplars } from '@/lib/policy-examples'

const N_SAMPLES = 3
const REPAIR_ROUNDS = 1
const POLICY_TEST_PER_POLICY = 3

const SYSTEM_PROMPT = `You are AEGIS's onboarding assistant. AEGIS audits and controls AI agents.
Given a plain-English description of an agent — written by anyone from a solo developer
("a Telegram bot for my homelab") to an enterprise team ("our healthcare-fintech support
copilot") — produce a security configuration bundle the AEGIS gateway will load.

Return ONLY valid JSON of this exact shape (no markdown fences, no commentary). The
FIRST field MUST be "reasoning" — describe in 2-4 sentences what tools the user has,
what risks the description names, and which policies + DSL rules you will write before
you emit them. This is a thinking scratchpad. After "reasoning", emit "policies" then "dsl":

{
  "reasoning": "short paragraph about the policies + DSL you are about to write",
  "policies": [
    {
      "id": "kebab-case-id",
      "name": "Short Human Name",
      "description": "One sentence.",
      "risk_level": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
      // PREFERRED — one of the six known-safe templates (see TEMPLATES below)
      "template": { "kind": "...", "field": "...", ... },
      // OR — multiple ANDed/ORed constraints
      "composite": { "all_of": true, "templates": [ ... ] },
      // ESCAPE HATCH — raw JSON Schema (use only if no template fits)
      "policy_schema": { /* JSON Schema (draft-07) applied to arguments */ },
      "tests": {
        "should_block": [ { "tool": "<tool name>", "arguments": { ... } } ],
        "should_allow": [ { "tool": "<tool name>", "arguments": { ... } } ]
      }
    }
  ],
  "dsl": {
    "version": 1,
    "rules": [
      { "name": "kebab-case-name", "when": { ... }, "then": { "decision": "allow" | "pending" | "block", "reason": "short" } }
    ]
  }
}

TEMPLATES (use these whenever they fit — they are formally validated and
compile-tested, so the gateway can never reject them as malformed):

  1. { "kind": "forbid_argument", "field": "<name>" }
     — argument MUST be absent or empty (any real value rejected).
     Use for: "no shell commands", "no raw SQL passthrough".

  2. { "kind": "require_pattern", "field": "<name>", "pattern": "<regex>" }
     — argument MUST exist AND match the regex.
     Use for: "url must start with https://api.example.com/".

  3. { "kind": "forbid_pattern", "field": "<name>", "pattern": "<regex>" }
     — argument MUST NOT match the regex (substring denylist).
     Use for: "command must not contain rm -rf", "no DROP TABLE".

  4. { "kind": "max_length", "field": "<name>", "max": N }
     — argument's string length ≤ N. Use for prompt-injection caps.

  5. { "kind": "enum_values", "field": "<name>", "allowed": [...] }
     — argument MUST be one of the listed values.
     Use for: "HTTP method ∈ {GET, HEAD}", "table ∈ {users, audit}".

  6. { "kind": "require_https", "field": "<name>" }
     — argument MUST be an HTTPS URL. Sugar for require_pattern: ^https://.

COMPOSITE — combine multiple templates with AND (default) or OR:
    { "all_of": true, "templates": [<tpl1>, <tpl2>, ...] }
  • Same-field templates fold into a per-field allOf/anyOf.
  • Different-field templates yield independent field constraints.

POLICY_SCHEMA fallback rules (only when no template fits):
  • The schema is applied to the call's "arguments" object. validate(arguments) === false ⇒ blocked.
  • To FORBID a substring: {"not": {"pattern": "<regex>"}}
  • To enforce HTTPS: {"pattern": "^https://"}
  • To bound a string: {"maxLength": N}
  • Empty schema (e.g. {}) matches everything ⇒ blocks nothing — useless.
  • Use \`additionalProperties: true\` so unknown fields don't cause spurious failures.
  • If you need to block by TOOL NAME, do it via DSL — the policy_schema only sees args.

TESTS rules — these are your OWN self-spec; we run them through AJV:
  • Each test is { tool, arguments }. \`tool\` is informational. \`arguments\` goes to AJV.
  • should_block MUST FAIL the schema (validate() === false).
  • should_allow MUST PASS the schema (validate() === true).
  • Cover at least one boundary case (e.g. https-vs-http, near-max-length).

DSL CONDITION syntax (rule.when):
  Field-path equality:    { "classifier.category": "shell" }
  Comparator object:      { "anomaly.score": { ">": 0.7 } }
  Available comparators:  ==, !=, >, <, >=, <=, in, matches
  Combinators:            { "all": [...] }, { "any": [...] }, { "not": ... }

Available context fields:
  classifier.category  ("shell" | "database" | "file" | "network" | "communication" | "other")
  classifier.signals   (array of strings)
  anomaly.score        (0..1)
  anomaly.p_value      (0..1 — small means anomalous, from conformal calibrator)
  anomaly.drift        (boolean — true when ADWIN flagged behavioural drift)
  policy.passed        (boolean)
  policy.violations    (array of strings)
  tool.name            (string)
  tool.args.<key>      (varies)
  agent.id             (uuid)
  tenant.deploymentMode ("default" | "financial" | "healthcare" | "edu" | ...)

Guidelines:
  • Lead with the strictest rules first; DSL evaluates top-to-bottom, first match wins.
  • DSL can only make decisions STRICTER than the base AJV result. "allow" rules don't
    override AJV blocks — fail-safe by design.
  • Prefer "pending" (human review) over "block" for ambiguous calls. For a solo developer
    who has no one to review pending calls, prefer "block" with a clear reason.
  • Only key rules on tenant.deploymentMode if the user mentions a sector / mode.
  • Match rule count to description complexity — three sentences should produce two or
    three focused rules, not twelve.
  • Generate concise reasons that are friendly to humans reading audit rows.

GROUNDING ON THE SCANNED AGENT:
  • When additional context includes "tool_inventory", treat that list as the AGENT'S
    ACTUAL TOOL SURFACE. Do NOT invent tool names that aren't on the list.
  • If the user describes blocking behaviour for a category (e.g. "block destructive DB")
    and the inventory contains a matching tool (e.g. db_query), key the rule on that real tool.
  • If "workflow_kinds" is present (e.g. ["langgraph"]), prefer rules that reference the
    framework's typical anti-patterns.

WORKFLOW GRAPH (highest-precision grounding when present):
  • When context includes "workflow_graph" with { framework, nodes, edges, entry_points,
    terminals }, treat it as the AGENT'S ACTUAL EXECUTION TOPOLOGY. The graph already
    enumerates every node — for each node you generate at least one policy or DSL rule,
    you SHOULD reference the node id verbatim (no invention).
  • For each "agent" / "tool" / "router" node, ask "what would the most-restrictive
    legitimate use of THIS node look like?" — that's the policy / DSL rule.
  • For "sensitive_relay" risk: if two adjacent nodes carry data of different
    sensitivities (e.g. database read → external send), generate an inter-node DSL rule
    keyed on tool.name pairs that catches the relay.
  • Entry-point nodes get tighter input validation (they receive untrusted user input).
  • Terminal nodes (END / sinks / outbound calls) get tighter egress validation
    (data leaving the gateway).
  • Edges labelled "handoff" between agents inherit both agents' policies AND get an
    additional DSL rule that the source agent must classify the handoff payload before
    sending. Models the multi-agent exfil class.

CAPABILITY RISK (when context includes "capability_risk"):
  • The scorer ranks the agent's THEORETICAL damage potential 0-100 from its tool set.
  • Rules of thumb: ≥ 70 = elevated; tighten EVERY policy to "block" instead of
    "pending"; add a tenant-mode='financial'-style escalation DSL rule.
  • < 30 = light-touch; over-restrictive rules will be noise.`

const REPAIR_PROMPT_PREFIX = `The previous bundle failed validation. Repair ONLY the
issues listed below and return the full corrected bundle (same JSON shape — reasoning,
policies, dsl). Do not remove valid policies. Do not introduce new issues. Issues:`

// ── LLM I/O ────────────────────────────────────────────────────────────

interface LLMCallOptions {
  provider: string
  apiKey: string
  systemPrompt: string
  exemplarTranscript: Array<{ role: 'user' | 'assistant'; content: string }>
  userPrompt: string
  /** Sampling temperature; 0 for the repair pass, 0.7 for the N-sample fan-out. */
  temperature: number
}

async function callLLM(opts: LLMCallOptions): Promise<string> {
  if (opts.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        temperature: opts.temperature,
        system: opts.systemPrompt,
        messages: [...opts.exemplarTranscript, { role: 'user', content: opts.userPrompt }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic API error: ${await res.text()}`)
    const data = await res.json()
    return data.content?.[0]?.text ?? ''
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: opts.temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: opts.systemPrompt },
        ...opts.exemplarTranscript,
        { role: 'user', content: opts.userPrompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI API error: ${await res.text()}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return JSON.parse(fenced[1].trim())
  const m = raw.match(/(\{[\s\S]*\})/)
  if (m) return JSON.parse(m[1])
  return JSON.parse(raw.trim())
}

interface ValidationReport {
  rounds: number
  samples_drawn: number
  issues: string[]
  test_results: Array<{
    policy_id: string
    block_pass: number; block_fail: number
    allow_pass: number; allow_fail: number
  }>
  score: number
}

interface Candidate {
  bundle: Bundle
  report: ValidatorReport
}

function evaluateRaw(raw: string): Candidate | null {
  let bundle: Bundle
  try { bundle = extractJson(raw) as Bundle }
  catch { return null }
  return { bundle, report: runValidator(bundle) }
}

// ── Route ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const { description, context, provider, apiKey } = await request.json()
    if (!description?.trim()) return NextResponse.json({ error: 'description is required' }, { status: 400 })
    if (!apiKey?.trim())      return NextResponse.json({ error: 'apiKey is required — configure it in Settings → AI Assistant' }, { status: 400 })

    // Workflow gap analysis (unchanged)
    const toolInventory: ToolInventoryEntry[] = Array.isArray(context?.tool_inventory)
      ? context.tool_inventory.filter((t: any) => t?.name).map((t: any) => ({ name: t.name, shape: t.shape }))
      : []
    const workflowGap = analyzeWorkflowGap(description, toolInventory);

    // Few-shot exemplar transcript — picked by lexical similarity.
    // We rebuild the model's expected I/O alternation: each exemplar
    // becomes (user description, assistant JSON output) pair before
    // the actual user request.
    const exemplars = pickExemplars(description, 2);
    const exemplarTranscript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const ex of exemplars) {
      const exUser = ex.context
        ? `${ex.description}\n\nAdditional context:\n${JSON.stringify(ex.context, null, 2)}`
        : ex.description;
      exemplarTranscript.push({ role: 'user', content: exUser });
      exemplarTranscript.push({ role: 'assistant', content: ex.output });
    }

    const userPrompt = context
      ? `Description:\n${description}\n\nAdditional context (scanner findings — ground policies on these):\n${JSON.stringify(context, null, 2)}\n\nFor each policy include a "tests" block with at least ${POLICY_TEST_PER_POLICY} should_block and ${POLICY_TEST_PER_POLICY} should_allow examples. Remember: emit "reasoning" FIRST.`
      : `${description}\n\nFor each policy include a "tests" block with at least ${POLICY_TEST_PER_POLICY} should_block and ${POLICY_TEST_PER_POLICY} should_allow examples. Remember: emit "reasoning" FIRST.`;

    // ── Round 1: N-sample fan-out ────────────────────────────────────
    // Spawn N concurrent calls at temperature=0.7. Self-consistency:
    // each diverges slightly, validator picks the winner. If any sample
    // is ok=true we shortcut.
    const fanOut = await Promise.all(
      Array.from({ length: N_SAMPLES }, () =>
        callLLM({
          provider: provider ?? 'openai',
          apiKey,
          systemPrompt: SYSTEM_PROMPT,
          exemplarTranscript,
          userPrompt,
          temperature: 0.7,
        }).then(evaluateRaw).catch(() => null),
      ),
    );
    const candidates: Candidate[] = fanOut.filter((c): c is Candidate => c !== null);

    let best: Candidate | null = null;
    for (const c of candidates) {
      if (!best || c.report.score > best.report.score
        || (c.report.score === best.report.score && c.report.issues.length < best.report.issues.length)) {
        best = c;
      }
    }
    if (best && best.report.ok) {
      return NextResponse.json({
        bundle: best.bundle,
        validation: {
          rounds: 1, samples_drawn: candidates.length,
          issues: [], test_results: best.report.testResults, score: best.report.score,
        } satisfies ValidationReport,
        workflow_gap: workflowGap,
      });
    }

    // ── Round 2: critique-and-refine on the best partial ─────────────
    // PerFine (arXiv 2510.24469) pattern: best-of-N + 1 targeted repair
    // round. Temperature=0 so the repair is deterministic given the
    // issues list.
    if (best) {
      for (let r = 0; r < REPAIR_ROUNDS; r++) {
        const current: Candidate = best;
        const repairPrompt: string = `${REPAIR_PROMPT_PREFIX}\n- ${current.report.issues.slice(0, 10).join('\n- ')}\n\nPrevious bundle (repair this):\n${JSON.stringify(current.bundle)}`;
        const repaired = await callLLM({
          provider: provider ?? 'openai',
          apiKey,
          systemPrompt: SYSTEM_PROMPT,
          exemplarTranscript,
          userPrompt: repairPrompt,
          temperature: 0,
        }).then(evaluateRaw).catch(() => null);
        if (repaired) {
          if (repaired.report.score > current.report.score
            || (repaired.report.score === current.report.score && repaired.report.issues.length < current.report.issues.length)) {
            best = repaired;
          }
          if (best.report.ok) break;
        }
      }
    }

    if (!best) {
      return NextResponse.json({ error: 'failed to produce any parseable bundle' }, { status: 502 });
    }
    return NextResponse.json({
      bundle: best.bundle,
      validation: {
        rounds: 1 + (best.report.ok ? 0 : REPAIR_ROUNDS),
        samples_drawn: candidates.length,
        issues: best.report.issues,
        test_results: best.report.testResults,
        score: best.report.score,
      } satisfies ValidationReport,
      workflow_gap: workflowGap,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Failed to generate policy bundle' }, { status: 500 });
  }
}
