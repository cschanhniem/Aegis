/**
 * Custom scan rules — YAML / JSON-driven detection rules layered on
 * top of the built-in scanner signatures.
 *
 * Why this exists: enterprise customers want to express their own
 * detections without forking the scanner. Semgrep is the gold-standard
 * UX for this — declarative YAML, AST-aware, per-rule severity. We
 * implement the subset that matters for AGENT / LLM detection:
 *
 *   1. `regex` — single regex, anchored to source text. Fastest path.
 *   2. `ast`   — match specific tree-sitter node types (Python AST
 *                already loaded for the AST detector); the rule
 *                specifies node-type + optional text predicate.
 *   3. `tool_call` — semantic match for a tool by name + argument
 *                pattern. Targets LangChain `Tool(name=...)` /
 *                OpenAI function-spec / Vercel AI SDK shapes the
 *                scanner already understands.
 *
 * Rules are loaded from a directory (passed via `--rules <dir>` on the
 * scanner CLI). Each `.yaml`/`.yml`/`.json` file under that directory
 * is parsed and validated. Invalid rules log a warning and are skipped
 * — never crashing the scan.
 *
 * Rule file shape:
 *
 *   rules:
 *     - id: acme.no-secrets-in-prompt
 *       severity: HIGH
 *       message: Tool argument contains a credential-shaped string.
 *       languages: [python, javascript]
 *       match:
 *         regex: 'sk_live_[A-Za-z0-9]{24,}'
 *
 *     - id: acme.no-internal-sql-from-agent
 *       severity: CRITICAL
 *       message: Direct DB writes from agent code are forbidden.
 *       languages: [python]
 *       match:
 *         ast:
 *           kind: call
 *           function: 'db\\.execute'    # regex on function text
 *
 *     - id: acme.deprecated-tool
 *       severity: MEDIUM
 *       message: legacy_query tool was deprecated 2026-04-15.
 *       match:
 *         tool_call:
 *           name: legacy_query
 *
 * Rule severities map to AEGIS's existing risk_level enum:
 *   CRITICAL, HIGH, MEDIUM, LOW, INFO (alias for LOW).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'

const VALID_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'])
const VALID_LANGS = new Set(['python', 'javascript', 'go', 'any'])

/** Try to parse a YAML or JSON string. We avoid the `js-yaml` dep by
 *  using a tiny purpose-built YAML subset parser for the rule shape
 *  (top-level `rules:` list of rules with shallow scalars). Falls back
 *  to JSON.parse for .json files. */
function parseYamlSubset(text) {
  // The rule file has a very narrow shape; rather than ship a full
  // YAML parser we recognise:
  //   - top-level "rules:" line (required)
  //   - "- key: value" entries
  //   - nested "key:" + "  subkey: value" (single-level indentation)
  //   - list entries `[a, b]` and quoted strings.
  // If the file uses features we don't recognise, the parser bails and
  // returns null — the caller falls through to JSON.parse, which
  // surfaces a clear error to the operator.
  const lines = text.split('\n')
  if (!lines.some(l => /^\s*rules\s*:\s*$/.test(l) || /^\s*rules\s*:\s*\[/.test(l))) return null
  const rules = []
  let current = null
  let nested = null
  // The indent of properties directly on the rule object — set by the
  // first "key: value" we see after "- id:" line. Anything strictly
  // deeper than this lives in `nested` (one-level nesting only).
  let ruleIndent = -1
  let nestedIndent = -1

  function setKey(target, key, val) {
    const trimmed = val.trim()
    if (trimmed === '') return
    target[key] = parseScalar(trimmed)
  }

  function parseScalar(s) {
    if ((s.startsWith('"') && s.endsWith('"'))
     || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
    if (s.startsWith('[') && s.endsWith(']')) {
      return s.slice(1, -1).split(',').map(p => parseScalar(p.trim())).filter(Boolean)
    }
    if (s === 'true')  return true
    if (s === 'false') return false
    if (s === 'null')  return null
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
    return s
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '')   // strip trailing comments
    if (!line.trim() || /^\s*#/.test(line)) continue

    // top-level "rules:"
    if (/^\s*rules\s*:\s*$/.test(line)) continue

    // "- id: ..." starts a new rule
    const startRule = line.match(/^(\s*)-\s*(\w+)\s*:\s*(.*)$/)
    if (startRule) {
      current = {}
      rules.push(current)
      nested = null
      nestedIndent = -1
      // The first key after the dash defines the rule-property indent.
      ruleIndent = startRule[1].length + 2;   // dash + space
      setKey(current, startRule[2], startRule[3])
      continue
    }

    // Indented "key: value" within current rule or nested object
    const m = line.match(/^(\s*)(\w+)\s*:\s*(.*)$/)
    if (m && current) {
      const indent = m[1].length
      const key = m[2]
      const val = m[3]
      if (indent <= ruleIndent) {
        // direct property of the rule
        if (val === '') {
          // beginning a nested object — clear value, expect deeper indent next
          current[key] = {}
          nested = current[key]
          nestedIndent = -1
        } else {
          setKey(current, key, val)
          nested = null
        }
      } else if (nested) {
        // First child of the nested object sets the nested-property indent.
        if (nestedIndent === -1) nestedIndent = indent
        if (indent === nestedIndent) {
          setKey(nested, key, val)
        }
      }
    }
  }
  return { rules }
}

/** Validate a parsed rule against the documented shape. Returns
 *  { ok, rule } or { ok:false, reason }. */
function validateRule(r) {
  if (!r || typeof r !== 'object') return { ok: false, reason: 'rule must be object' }
  if (!r.id || typeof r.id !== 'string') return { ok: false, reason: 'rule.id required' }
  if (!r.message || typeof r.message !== 'string') return { ok: false, reason: 'rule.message required' }
  const severity = (r.severity ?? 'MEDIUM').toUpperCase()
  if (!VALID_SEVERITIES.has(severity)) return { ok: false, reason: `invalid severity: ${r.severity}` }
  const langs = Array.isArray(r.languages)
    ? r.languages.map(l => String(l).toLowerCase())
    : (r.language ? [String(r.language).toLowerCase()] : ['any'])
  for (const l of langs) if (!VALID_LANGS.has(l)) return { ok: false, reason: `invalid language: ${l}` }
  if (!r.match || typeof r.match !== 'object') return { ok: false, reason: 'rule.match required' }
  const kinds = ['regex', 'ast', 'tool_call'].filter(k => r.match[k] !== undefined)
  if (kinds.length === 0) return { ok: false, reason: 'rule.match needs one of: regex / ast / tool_call' }
  if (kinds.length > 1) return { ok: false, reason: 'rule.match may have only one matcher' }
  // Per-matcher shape check
  if (r.match.regex && typeof r.match.regex !== 'string') return { ok: false, reason: 'match.regex must be string' }
  if (r.match.ast) {
    if (typeof r.match.ast !== 'object' || !r.match.ast.kind) return { ok: false, reason: 'match.ast.kind required' }
  }
  if (r.match.tool_call) {
    if (typeof r.match.tool_call !== 'object' || !r.match.tool_call.name) {
      return { ok: false, reason: 'match.tool_call.name required' }
    }
  }
  // Compile regex up front so a malformed pattern surfaces at load time.
  try {
    if (r.match.regex)            new RegExp(r.match.regex)
    if (r.match.ast?.function)    new RegExp(r.match.ast.function)
    if (r.match.tool_call?.arg_pattern) new RegExp(r.match.tool_call.arg_pattern)
  } catch (err) {
    return { ok: false, reason: `invalid regex: ${err.message}` }
  }
  return {
    ok: true,
    rule: {
      id: r.id, message: r.message, severity,
      languages: langs,
      match: r.match,
    },
  }
}

/** Load every rule file under a directory. Returns the list of valid
 *  rules + a summary of skipped files (warning messages). */
export function loadRules(rulesDir) {
  if (!rulesDir || !existsSync(rulesDir)) return { rules: [], warnings: [] }
  const stat = statSync(rulesDir)
  if (!stat.isDirectory()) return { rules: [], warnings: [`rules path is not a directory: ${rulesDir}`] }

  const rules = []
  const warnings = []
  const files = readdirSync(rulesDir)
    .filter(f => ['.yaml', '.yml', '.json'].includes(extname(f).toLowerCase()))
    .map(f => join(rulesDir, f))

  for (const file of files) {
    let parsed
    try {
      const text = readFileSync(file, 'utf8')
      if (extname(file).toLowerCase() === '.json') {
        parsed = JSON.parse(text)
      } else {
        parsed = parseYamlSubset(text)
        if (!parsed) {
          warnings.push(`failed to parse YAML: ${file}`)
          continue
        }
      }
    } catch (err) {
      warnings.push(`failed to read ${file}: ${err.message}`)
      continue
    }
    if (!parsed || !Array.isArray(parsed.rules)) {
      warnings.push(`${file}: top-level "rules:" array missing`)
      continue
    }
    for (const r of parsed.rules) {
      const v = validateRule(r)
      if (!v.ok) {
        warnings.push(`${file}: rule "${r?.id ?? '<unnamed>'}" skipped — ${v.reason}`)
        continue
      }
      rules.push(v.rule)
    }
  }
  return { rules, warnings }
}

/** Apply rules to a single file's source. Returns an array of
 *  findings (zero or more per rule × file). The caller supplies an
 *  optional `astHints` object so AST + tool_call matchers can run
 *  without re-parsing.
 *
 *    astHints = {
 *      ast?: rootNode,                 // tree-sitter Node when available
 *      toolCalls?: Array<{ name, argsText }>,
 *    }
 */
export function applyRules(rules, opts) {
  const out = []
  if (!rules || rules.length === 0) return out
  const { path, source, language, astHints } = opts

  for (const rule of rules) {
    if (!rule.languages.includes('any') && !rule.languages.includes(language)) continue
    let hit = null
    if (rule.match.regex) {
      const re = new RegExp(rule.match.regex, 'm')
      const m = source.match(re)
      if (m) {
        const idx = source.indexOf(m[0])
        const line = idx >= 0 ? source.slice(0, idx).split('\n').length : 1
        hit = { line, evidence: truncate(m[0], 120) }
      }
    } else if (rule.match.ast && astHints?.ast) {
      const found = findInAst(astHints.ast, rule.match.ast)
      if (found) hit = { line: found.line, evidence: truncate(found.text, 120) }
    } else if (rule.match.tool_call && Array.isArray(astHints?.toolCalls)) {
      const wantedName = rule.match.tool_call.name
      const argRe = rule.match.tool_call.arg_pattern ? new RegExp(rule.match.tool_call.arg_pattern) : null
      const match = astHints.toolCalls.find(tc =>
        tc.name === wantedName && (!argRe || (tc.argsText && argRe.test(tc.argsText))),
      )
      if (match) hit = { line: match.line ?? 1, evidence: truncate(match.argsText ?? '', 120) }
    }
    if (hit) {
      out.push({
        rule_id: rule.id,
        severity: rule.severity,
        message: rule.message,
        path,
        line: hit.line,
        evidence: hit.evidence,
      })
    }
  }
  return out
}

function truncate(s, n) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** Pre-order AST search. Matches when node.type equals rule.kind AND
 *  the function-text (for call nodes) matches the optional function regex. */
function findInAst(root, astRule) {
  const stack = [root]
  const wantedKind = astRule.kind
  const fnRe = astRule.function ? new RegExp(astRule.function) : null
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    if (node.type === wantedKind) {
      // For call-type nodes, the conventional Python/JS field is
      // "function". Tree-sitter exposes it via childForFieldName.
      let text = node.text
      let line = (node.startPosition?.row ?? 0) + 1
      if (fnRe) {
        const fn = node.childForFieldName?.('function')
        if (fn) text = fn.text
        if (!text || !fnRe.test(text)) {
          // No match on the function predicate; keep walking children.
        } else {
          return { text, line }
        }
      } else {
        return { text, line }
      }
    }
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      const c = node.child(i)
      if (c) stack.push(c)
    }
  }
  return null
}
