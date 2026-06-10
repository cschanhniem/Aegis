#!/usr/bin/env node
/**
 * AEGIS repo scanner — three detection paths, one report.
 *
 *   import   .py / .ts / .tsx / .js / .mjs / .cjs / .go         file IMPORTS an LLM SDK
 *   http     same source files                                  file POSTs to a vendor URL
 *   mcp      claude_desktop_config.json / .mcp.json / etc.      MCP server declaration
 *
 * Each candidate carries:
 *   - kind          ('import' | 'http' | 'mcp')
 *   - framework     short id (anthropic / openai-http / claude-desktop-config…)
 *   - remediation   the suggested next step for the wizard / injector:
 *                     'sdk-inject'      → run codemod-inject on this file
 *                     'egress-proxy'    → re-point base_url at /api/v1/llm-proxy/<provider>
 *                     'mcp-proxy'       → wire the MCP client through AEGIS's mcp proxy
 *
 * Output (JSON, --json) is backward-compatible: callers that already
 * read `candidates[].framework / language / is_entry_point` keep working;
 * the new fields are additive.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { extname, join, relative, basename, resolve, dirname } from 'node:path'
import {
  IMPORT_SIGNATURES,
  HTTP_SIGNATURES,
  MCP_CONFIG_FILES,
  WORKFLOW_PATTERNS,
  TOOL_DECL_PATTERNS,
  ALREADY_PROTECTED_PATTERNS,
  SOURCE_EXTS,
  languageOf,
} from './signatures.mjs'
import { blankOutStrings } from './preprocess.mjs'
import { tryDetectPython } from './ast-python.mjs'
import { tryDetectJs } from './ast-js.mjs'
import { loadRules, applyRules } from './custom-rules.mjs'
import { scanFileForSecrets } from './secret-scanner.mjs'
import { extractWorkflowGraph, aggregateWorkflowGraphs } from './workflow-graph.mjs'

/** Map AST framework id → human label, mirroring IMPORT_SIGNATURES.
 *  Kept here (not in signatures.mjs) so the AST module stays decoupled
 *  from the regex table and we can evolve them independently. */
const PY_FRAMEWORK_NAMES = {
  anthropic: 'Anthropic', openai: 'OpenAI', langchain: 'LangChain',
  langgraph: 'LangGraph', crewai: 'CrewAI', llamaindex: 'LlamaIndex',
  mistral: 'Mistral', gemini: 'Google Gemini', smolagents: 'smolagents',
  'pydantic-ai': 'Pydantic AI', autogen: 'AutoGen', haystack: 'Haystack',
  dspy: 'DSPy', cohere: 'Cohere', together: 'Together', ollama: 'Ollama',
  groq: 'Groq', replicate: 'Replicate', bedrock: 'AWS Bedrock',
}

const JS_FRAMEWORK_NAMES = {
  'anthropic-js':   'Anthropic (JS)',
  'openai-js':      'OpenAI (JS)',
  'vercel-ai':      'Vercel AI SDK',
  'mastra':         'Mastra',
  'langchain-js':   'LangChain (JS)',
  'mistral-js':     'Mistral (JS)',
  'cohere-js':      'Cohere (JS)',
  'ollama-js':      'Ollama (JS)',
  'groq-js':        'Groq (JS)',
}

const DEFAULT_MAX_FILES = 5_000
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'target', 'out', 'coverage',
  '.cache', '.idea', '.tox', '.eggs', '.gradle', 'vendor',
])
const TEST_DIR_RE  = /(^|\/)(__tests__|tests?|spec|fixtures)(\/|$)/i
const TEST_FILE_RE = /(\.test|\.spec|_test)\.(py|ts|tsx|js|mjs|cjs|go)$/i

const ENTRY_FILE_PATTERNS = [
  /^main\.py$/i, /^app\.py$/i, /^server\.py$/i, /^run\.py$/i,
  /^worker\.py$/i, /^__main__\.py$/i, /^cli\.py$/i,
  /^index\.(m?[jt]sx?|cjs)$/i, /^server\.(m?[jt]sx?|cjs)$/i,
  /^app\.(m?[jt]sx?|cjs)$/i, /^main\.(m?[jt]sx?|cjs)$/i,
  /^main\.go$/i, /^cmd\/[^/]+\/main\.go$/i,
]

function readArgs(argv) {
  const out = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json')               out.json = true
    else if (a === '--include-tests') out.includeTests = true
    else if (a === '--max-files')     out.maxFiles = Number(argv[++i])
    else if (a.startsWith('--'))      out[a.slice(2)] = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : 'true'
    else                              out.positional.push(a)
  }
  return out
}

/** Walk the tree, return source files + config files we care about
 *  (split so we don't re-stat each candidate twice). */
function walk(root, opts) {
  const includeTests = opts.includeTests === true
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES

  // MCP config files are matched by relative path (some live in
  // `.cursor/mcp.json` so basename alone isn't enough).
  const wantConfigByRel  = new Set(MCP_CONFIG_FILES.filter(c => c.filename.includes('/')).map(c => c.filename))
  const wantConfigByBase = new Map()   // basename → config descriptor
  for (const c of MCP_CONFIG_FILES) {
    if (!c.filename.includes('/')) wantConfigByBase.set(c.filename, c)
  }

  const sourceFiles = []
  const configHits  = []   // { abs, rel, descriptor }
  const stack = [root]
  while (stack.length && (sourceFiles.length + configHits.length) < maxFiles) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) }
    catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        // Allow .cursor / .vscode / .continue / .config / .windsurfrc-dir
        // through the dotfile filter; their config files live there.
        const isAgentDot = ['.cursor', '.vscode', '.continue', '.config', '.windsurf'].includes(entry.name)
        if (entry.name.startsWith('.') && !isAgentDot && entry.name !== '.well-known') continue
        const rel = relative(root, full).replaceAll('\\', '/')
        if (!includeTests && TEST_DIR_RE.test('/' + rel)) continue
        stack.push(full)
      } else if (entry.isFile()) {
        const rel = relative(root, full).replaceAll('\\', '/')
        // 1. Config file? Check the *most-specific* match first
        //    (`.cursor/mcp.json` beats the generic `mcp.json`).
        let matchedConfig = null
        for (const wantRel of wantConfigByRel) {
          if (rel === wantRel || rel.endsWith('/' + wantRel)) {
            matchedConfig = MCP_CONFIG_FILES.find(c => c.filename === wantRel) ?? null
            break
          }
        }
        if (!matchedConfig) {
          const baseDesc = wantConfigByBase.get(entry.name)
          if (baseDesc) matchedConfig = baseDesc
        }
        if (matchedConfig) {
          configHits.push({ abs: full, rel, descriptor: matchedConfig })
          continue
        }
        // 2. Source file?
        const ext = extname(entry.name).toLowerCase()
        if (!SOURCE_EXTS.has(ext)) continue
        if (!includeTests && TEST_FILE_RE.test(entry.name)) continue
        sourceFiles.push(full)
      }
    }
  }
  return { sourceFiles, configHits }
}

function safeRead(file) {
  try {
    const stat = statSync(file)
    if (stat.size > 2_000_000) return null
    return readFileSync(file, 'utf8')
  } catch { return null }
}

function safeReadJson(file) {
  const text = safeRead(file)
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

function detectImports(text, fileLang) {
  if (!text || !fileLang) return []
  const out = []
  for (const fw of IMPORT_SIGNATURES) {
    if (fw.lang !== fileLang) continue
    for (const pat of fw.patterns) {
      if (pat.test(text)) {
        out.push({ id: fw.id, name: fw.name, lang: fw.lang, evidence: pat.source })
        break
      }
    }
  }
  return out
}

function detectHttp(text) {
  if (!text) return []
  const out = []
  for (const sig of HTTP_SIGNATURES) {
    for (const pat of sig.patterns) {
      if (pat.test(text)) {
        out.push({ id: sig.id, name: sig.name, endpoint: sig.endpoint, evidence: pat.source })
        break
      }
    }
  }
  return out
}

/** Returns the set of declared tools found in this file. De-duplicates
 *  by name (the same tool may show up under both a Tool() construct
 *  and a function-call spec). */
function detectTools(text, fileLang) {
  if (!text) return []
  const out = new Map()
  for (const p of TOOL_DECL_PATTERNS) {
    if (p.lang !== 'any' && p.lang !== fileLang) continue
    let hits
    try { hits = p.extract(text) } catch { hits = [] }
    for (const t of hits) {
      if (!t?.name) continue
      const k = t.name
      if (!out.has(k)) out.set(k, { name: t.name, shape: t.shape ?? p.id })
    }
  }
  return [...out.values()]
}

/** Returns the workflow patterns matched in this file, or [] if none.
 *  Used to elevate "this is a real agent entry-point" candidates above
 *  bare-import files. */
function detectWorkflows(text, fileLang) {
  if (!text || !fileLang) return []
  const out = []
  for (const w of WORKFLOW_PATTERNS) {
    if (w.lang !== fileLang) continue
    for (const pat of w.patterns) {
      if (pat.test(text)) {
        out.push({ id: w.id, evidence: pat.source })
        break
      }
    }
  }
  return out
}

/** Confidence model:
 *    high    — workflow pattern matched (entry-point is unambiguous)
 *    high    — entry-point filename + import
 *    medium  — bare import in a non-entry file
 *    medium  — HTTP URL string literal
 *    low     — HTTP-only, no entry-point conventions, no enclosing module
 *
 *  Industrial reason for surfacing this: a wizard / CI pipeline can
 *  auto-inject `high` candidates, gate `medium` behind operator review,
 *  and demote `low` to "informational" so the noise floor is bounded.
 */
function confidenceFor({ kind, isEntry, fileLang, evidenceLen, isWorkflow }) {
  if (isWorkflow) return 'high'
  if (kind === 'import') {
    if (isEntry) return 'high'
    return evidenceLen >= 2 ? 'medium' : 'medium'
  }
  if (kind === 'http') {
    return isEntry ? 'medium' : 'low'
  }
  if (kind === 'mcp') return 'high'   // config files are unambiguous
  return 'low'
}

function isAlreadyProtected(text) {
  if (!text) return false
  return ALREADY_PROTECTED_PATTERNS.some(pat => pat.test(text))
}

function isEntryFile(file) {
  const base = basename(file)
  return ENTRY_FILE_PATTERNS.some(pat => pat.test(base))
}

function readRepoMetadata(root) {
  const out = { repo_name: undefined, version: undefined, owner_email: undefined }
  const py = join(root, 'pyproject.toml')
  if (existsSync(py)) {
    try {
      const t = readFileSync(py, 'utf8')
      const name = t.match(/^name\s*=\s*"([^"]+)"/m)?.[1]
      const ver  = t.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
      if (name) out.repo_name = name
      if (ver)  out.version   = ver
    } catch {}
  }
  const pkg = join(root, 'package.json')
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, 'utf8'))
      out.repo_name = out.repo_name ?? j.name
      out.version   = out.version   ?? j.version
    } catch {}
  }
  const gomod = join(root, 'go.mod')
  if (existsSync(gomod) && !out.repo_name) {
    try {
      const t = readFileSync(gomod, 'utf8')
      const m = t.match(/^module\s+(\S+)/m)
      if (m) {
        const last = m[1].split('/').pop()
        if (last) out.repo_name = last
      }
    } catch {}
  }
  for (const cand of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
    const f = join(root, cand)
    if (existsSync(f)) {
      try {
        const t = readFileSync(f, 'utf8')
        const m = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
        if (m) out.owner_email = m[0]
      } catch {}
      break
    }
  }
  return out
}

function suggestAgentId(repo, rel) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const noExt = rel.replace(/\.[^.]+$/, '')
  const parts = [repo, noExt].filter(Boolean).map(slug).filter(Boolean)
  return parts.join('-').slice(0, 80) || 'agent'
}

function rankCandidates(candidates) {
  // Order: import > http > mcp; entry-points first; then path.
  const kindRank = { import: 0, http: 1, mcp: 2 }
  return [...candidates].sort((a, b) => {
    if (a.kind !== b.kind) return kindRank[a.kind] - kindRank[b.kind]
    if (a.is_entry_point !== b.is_entry_point) return a.is_entry_point ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

/** Pick the AEGIS remediation suggestion for a candidate based on its
 *  kind. Surfaced in the report so the wizard can show the right "next
 *  step" without re-deriving the logic. */
function remediationFor(kind, framework) {
  switch (kind) {
    case 'import':
      return { action: 'sdk-inject', note: 'Run `agentguard inject` (or click Apply in the wizard) to add agentguard.auto() at the top of this file.' }
    case 'http':
      return {
        action: 'egress-proxy',
        note: `Point the client's base_url at \`<gateway>/api/v1/llm-proxy/${providerOf(framework)}\` and add header X-AEGIS-Key. The egress proxy will inspect every request before it leaves the network.`,
      }
    case 'mcp':
      return {
        action: 'mcp-proxy',
        note: 'Replace the MCP server entry with the AEGIS MCP proxy so the host runtime issues tool calls through the gateway.',
      }
    default:
      return { action: 'review', note: 'Manual review' }
  }
}

/**
 * Build a coarse cross-file import graph and propagate framework hits
 * transitively. A file that imports a local module which itself imports
 * an LLM SDK is *also* an LLM-using file (one helper layer is the most
 * common refactor pattern). One hop of propagation catches that without
 * needing a real call-graph.
 *
 * Inputs:
 *   sourceFiles   absolute paths
 *   readText      function(file) → text   (so we can re-use the safeRead cache)
 *   directHits    Map<absPath, Array<{ id, name, lang, evidence }>>
 *
 * Output:
 *   transitive Map<absPath, Array<{ via_file, framework, lang }>>
 *
 * Python: `from foo.bar import X`  / `import foo.bar`
 * JS/TS:  `from "./helpers/llm"`   / `require("./helpers/llm")`
 *
 * We only follow LOCAL imports (relative paths or paths that resolve
 * within `root`) — third-party imports are already in directHits.
 */
function buildTransitive(root, sourceFiles, readText, directHits) {
  const moduleOf = new Map()   // abs_path → module path (for matching imports)
  const filesByModule = new Map()   // module path → abs_path
  for (const f of sourceFiles) {
    const rel = relative(root, f).replaceAll('\\', '/')
    const noExt = rel.replace(/\.[^.]+$/, '')
    moduleOf.set(f, noExt)
    filesByModule.set(noExt, f)
    // Python: also index by dotted form so `from svc.helpers.llm` matches svc/helpers/llm.py
    filesByModule.set(noExt.replace(/\//g, '.'), f)
  }
  const transitive = new Map()
  for (const f of sourceFiles) {
    const text = readText(f)
    if (!text) continue
    const lang = languageOf(f)
    const dependsOn = new Set()

    if (lang === 'python') {
      // from foo.bar import X
      for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+/gm)) {
        const dotted = m[1].replace(/^\.+/, '')
        const target = filesByModule.get(dotted)
        if (target && target !== f) dependsOn.add(target)
      }
      // import foo.bar
      for (const m of text.matchAll(/^\s*import\s+([.\w]+)/gm)) {
        const dotted = m[1].replace(/^\.+/, '')
        const target = filesByModule.get(dotted)
        if (target && target !== f) dependsOn.add(target)
      }
    } else if (lang === 'javascript') {
      // from './helpers/llm' or "../lib/llm"
      for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = resolveJsImport(f, m[1], moduleOf)
        if (target && target !== f) dependsOn.add(target)
      }
      for (const m of text.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        const target = resolveJsImport(f, m[1], moduleOf)
        if (target && target !== f) dependsOn.add(target)
      }
    }

    for (const depFile of dependsOn) {
      const depHits = directHits.get(depFile) ?? []
      if (depHits.length === 0) continue
      // Inherit the dependency's primary framework attribution.
      const existing = transitive.get(f) ?? []
      for (const dh of depHits) {
        existing.push({ via_file: relative(root, depFile).replaceAll('\\', '/'), framework: dh.id, lang: dh.lang })
      }
      transitive.set(f, existing)
    }
  }
  return transitive
}

function resolveJsImport(fromFile, relSpec, moduleOf) {
  // Resolve "./helpers/llm" against fromFile's dir, then match against
  // the moduleOf reverse map. Try each candidate extension implied by
  // the suffix-stripped module key.
  const base = dirname(fromFile)
  const abs = resolveJoin(base, relSpec)
  // Search the moduleOf map for an entry whose abs path starts with
  // resolved + (any source extension).
  for (const [absPath, _modKey] of moduleOf) {
    if (absPath.startsWith(abs + '.')) return absPath
    if (absPath === abs + '/index.ts' || absPath === abs + '/index.js' || absPath === abs + '/index.mjs') return absPath
  }
  return null
}

function resolveJoin(base, spec) {
  // Minimal POSIX-style normalisation, sufficient for the rel specs we see.
  const segments = (base + '/' + spec).split(/[\\/]+/)
  const out = []
  for (const s of segments) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return (base.startsWith('/') ? '/' : '') + out.join('/')
}

function providerOf(http_id) {
  if (!http_id) return 'openai'
  // strip "-http" suffix to map to gateway proxy provider path
  const base = http_id.replace(/-http$/, '')
  if (base === 'gemini') return 'gemini'
  if (base === 'bedrock') return 'bedrock'   // not yet wired in proxy v1 — placeholder
  if (base === 'anthropic') return 'anthropic'
  if (base === 'mistral') return 'mistral'
  if (base === 'azure-openai') return 'openai'   // Azure speaks the OpenAI API shape
  return 'openai'
}

function detectMcpServers(configFile) {
  // Returns the list of MCP-server names declared in the file, if any.
  // Recognises the two common shapes:
  //   { "mcpServers": { "<name>": { "command": ..., "args": ... } } }
  //   { "servers":    [ { "name": ..., "command": ... } ] }
  const j = safeReadJson(configFile)
  if (!j || typeof j !== 'object') return []
  const out = []
  if (j.mcpServers && typeof j.mcpServers === 'object') {
    for (const name of Object.keys(j.mcpServers)) out.push(name)
  }
  if (Array.isArray(j.servers)) {
    for (const s of j.servers) {
      if (s?.name) out.push(String(s.name))
    }
  }
  return out
}

async function main(argv) {
  const args = readArgs(argv.slice(2))
  if (!args.positional.length) {
    console.error('Usage: repo-scanner <path> [--json] [--include-tests] [--max-files N]')
    process.exit(2)
  }
  const root = resolve(args.positional[0])
  if (!existsSync(root)) {
    console.error(`✗ path not found: ${root}`)
    process.exit(2)
  }
  const meta = readRepoMetadata(root)
  const { sourceFiles, configHits } = walk(root, args)

  const candidates = []

  // ── source-file candidates ──────────────────────────────────────
  // First pass: collect direct hits per file so we can build a
  // transitive-import graph over them.
  //
  // `fileText` holds RAW source. The earlier idea of blanking string
  // literals before regex matching was reverted: JS and Go imports
  // literally embed the module name inside string literals
  // (`from 'openai'`, `import "github.com/..."`), so blanking strings
  // would erase the signature. The cross-language language-filter on
  // SIGNATURES (each pattern carries a `lang` field) already
  // suppresses the snippet-in-.tsx false positives that motivated
  // this. The preprocess.mjs module is retained for future use on
  // Python-only docstring scenarios.
  const fileText = new Map()
  const fileCode = new Map()   // alias for legacy; same as fileText.
  const directImportHits = new Map()
  const pythonFiles = []
  const jsFiles = []   // [{ file, ext }] for the AST pre-pass below
  for (const file of sourceFiles) {
    const text = safeRead(file)
    if (text === null) continue
    fileText.set(file, text)
    fileCode.set(file, text)
    const lang = languageOf(file)
    const hits = detectImports(text, lang)
    if (hits.length > 0) directImportHits.set(file, hits)
    if (lang === 'python') pythonFiles.push(file)
    if (lang === 'javascript') {
      const ext = (file.slice(file.lastIndexOf('.')).toLowerCase())
      jsFiles.push({ file, ext })
    }
  }

  // ── Python AST pre-pass ─────────────────────────────────────────
  // Walk each .py file's syntax tree. AST detection ADDS to the regex
  // hits — it catches dynamic imports (importlib.import_module,
  // __import__) and confirms SDK constructor calls (raising confidence
  // from "imports the module" to "actually uses the SDK").
  //
  // The parser is loaded lazily; if web-tree-sitter / the wasm grammar
  // isn't reachable (e.g. zero-dep sidecar bundle) the AST module
  // returns null and the file silently falls back to regex-only.
  const astHits = new Map()   // file → astHits[] (or null on failure)
  if (pythonFiles.length > 0) {
    await Promise.all(pythonFiles.map(async f => {
      const out = await tryDetectPython(fileText.get(f))
      if (out && out.length > 0) astHits.set(f, out)
    }))
  }

  // ── JS/TS/TSX AST pre-pass ──────────────────────────────────────
  // Same shape as the Python pass — dynamic `import()`, `require()`,
  // and constructor calls (`new OpenAI()`, `new ChatAnthropic()`) that
  // the regex stage can't reach without false-positive risk.
  const jsAstHits = new Map()
  if (jsFiles.length > 0) {
    await Promise.all(jsFiles.map(async ({ file, ext }) => {
      const out = await tryDetectJs(fileText.get(file), ext)
      if (out && out.length > 0) jsAstHits.set(file, out)
    }))
  }

  // Fold AST findings into directImportHits. Regex hits take precedence
  // for the framework metadata (name + lang); AST contributes evidence
  // tags + the `ast_used` confidence elevation.
  for (const [file, astList] of astHits.entries()) {
    const existing = directImportHits.get(file) ?? []
    const have = new Set(existing.map(h => h.id))
    for (const a of astList) {
      if (have.has(a.fw)) {
        // Augment: thread AST evidence onto the existing hit so reports
        // include `dynamic:openai` or `constructor:Anthropic`.
        const slot = existing.find(h => h.id === a.fw)
        if (slot) {
          slot.ast_evidence = a.evidence
          if (a.used) slot.ast_used = true
        }
      } else {
        existing.push({
          id: a.fw,
          name: PY_FRAMEWORK_NAMES[a.fw] ?? a.fw,
          lang: 'python',
          evidence: 'ast',
          ast_evidence: a.evidence,
          ast_used: a.used,
        })
      }
    }
    directImportHits.set(file, existing)
  }
  for (const [file, astList] of jsAstHits.entries()) {
    const existing = directImportHits.get(file) ?? []
    const have = new Set(existing.map(h => h.id))
    for (const a of astList) {
      if (have.has(a.fw)) {
        const slot = existing.find(h => h.id === a.fw)
        if (slot) {
          slot.ast_evidence = a.evidence
          if (a.used) slot.ast_used = true
        }
      } else {
        existing.push({
          id: a.fw,
          name: JS_FRAMEWORK_NAMES[a.fw] ?? a.fw,
          lang: 'javascript',
          evidence: 'ast',
          ast_evidence: a.evidence,
          ast_used: a.used,
        })
      }
    }
    directImportHits.set(file, existing)
  }
  const transitive = buildTransitive(root, sourceFiles, (f) => fileText.get(f) ?? null, directImportHits)

  for (const file of sourceFiles) {
    const text = fileText.get(file)
    const code = fileCode.get(file)
    const lang = languageOf(file)
    if (!text) continue
    const importHits   = directImportHits.get(file) ?? []
    // HTTP signatures intentionally look INSIDE string literals.
    const httpHits     = detectHttp(text)
    const workflowHits = detectWorkflows(code, lang)
    const transitiveHits = transitive.get(file) ?? []
    // Tool declarations need RAW text — the string *values* inside
    // `{"name": "...", "description": "..."}` are the signature.
    const toolDecls    = detectTools(text, lang)
    // A workflow-pattern hit alone is sufficient to flag the file
    // (it's an unambiguous agent entry-point even if our import sigs
    // missed the framework). Otherwise require at least one direct,
    // HTTP, or transitive hit.
    if (importHits.length === 0 && httpHits.length === 0 && transitiveHits.length === 0 && workflowHits.length === 0) continue

    const rel = relative(root, file).replaceAll('\\', '/')
    const entry = isEntryFile(rel) || isEntryFile(file)
    const protectedFlag = isAlreadyProtected(text)
    const isWorkflow = workflowHits.length > 0

    if (importHits.length > 0) {
      candidates.push({
        kind: 'import',
        path: rel,
        abs_path: file,
        framework: importHits[0].id,
        framework_name: importHits[0].name,
        language: importHits[0].lang,
        evidence: importHits.map(h => ({ framework: h.id, signature: h.evidence })),
        is_entry_point: entry || isWorkflow,
        is_workflow_entry: isWorkflow,
        workflow_patterns: workflowHits.map(w => w.id),
        tools_declared: toolDecls,
        already_protected: protectedFlag,
        suggested_agent_id: suggestAgentId(meta.repo_name, rel),
        remediation: remediationFor('import'),
        confidence: confidenceFor({ kind: 'import', isEntry: entry, fileLang: lang, evidenceLen: importHits.length, isWorkflow }),
      })
    } else if (transitiveHits.length > 0) {
      // No direct import, but a local module this file imports IS an
      // LLM file. Treat the parent as a transitive-import candidate
      // (medium confidence; operator may or may not want to instrument).
      const primary = transitiveHits[0]
      candidates.push({
        kind: 'import',
        path: rel,
        abs_path: file,
        framework: primary.framework,
        framework_name: `${primary.framework} (transitive)`,
        language: primary.lang ?? lang ?? 'unknown',
        evidence: transitiveHits.map(t => ({ framework: t.framework, via_file: t.via_file })),
        is_entry_point: entry || isWorkflow,
        is_workflow_entry: isWorkflow,
        workflow_patterns: workflowHits.map(w => w.id),
        tools_declared: toolDecls,
        already_protected: protectedFlag,
        suggested_agent_id: suggestAgentId(meta.repo_name, rel),
        remediation: remediationFor('import'),
        transitive: true,
        confidence: isWorkflow ? 'high' : 'medium',
      })
    }
    if (httpHits.length > 0 && importHits.length === 0 && transitiveHits.length === 0) {
      const primary = httpHits[0]
      candidates.push({
        kind: 'http',
        path: rel,
        abs_path: file,
        framework: primary.id,
        framework_name: primary.name,
        endpoint:       primary.endpoint,
        language: lang ?? 'unknown',
        evidence: httpHits.map(h => ({ framework: h.id, endpoint: h.endpoint, signature: h.evidence })),
        is_entry_point: entry || isWorkflow,
        is_workflow_entry: isWorkflow,
        workflow_patterns: workflowHits.map(w => w.id),
        already_protected: protectedFlag,
        suggested_agent_id: suggestAgentId(meta.repo_name, rel),
        remediation: remediationFor('http', primary.id),
        confidence: confidenceFor({ kind: 'http', isEntry: entry, fileLang: lang, evidenceLen: httpHits.length, isWorkflow }),
      })
    }
  }

  // ── Custom-rule findings ────────────────────────────────────────
  // Run after the built-in detectors so customers can layer their own
  // rules on top. Findings ride out under `report.custom_findings` so
  // existing consumers ignore them unless they opt in.
  const customRulesDir = args['rules'] && args['rules'] !== 'true' ? args['rules'] : null
  const { rules: customRules, warnings: ruleWarnings } = loadRules(customRulesDir)
  if (customRulesDir && customRules.length === 0 && ruleWarnings.length === 0) {
    console.error(`Loaded 0 custom rules from ${customRulesDir} — directory present but empty`)
  } else if (customRules.length > 0) {
    console.error(`Loaded ${customRules.length} custom rule(s) from ${customRulesDir}`)
  }
  for (const w of ruleWarnings) console.error(`custom-rules: ${w}`)
  const customFindings = []
  if (customRules.length > 0) {
    for (const file of sourceFiles) {
      const text = fileText.get(file)
      if (!text) continue
      const lang = languageOf(file)
      if (!lang) continue
      const rel = relative(root, file).replaceAll('\\', '/')
      // The AST hint object is best-effort. We pass undefined for
      // `ast` here — running rules in-line with the tree-sitter
      // tree would require keeping it alive past the AST pre-pass,
      // which we don't do for memory reasons. Regex + tool_call
      // matchers cover the 90% case; ast matchers degrade to
      // string-only text matches when no tree is available.
      const hits = applyRules(customRules, {
        path: rel,
        source: text,
        language: lang,
        astHints: {},
      })
      for (const h of hits) customFindings.push(h)
    }
  }

  // ── Secret scanning ─────────────────────────────────────────────
  // Runs over every source file (and every MCP config too, since those
  // sometimes hold bearer tokens). Skipped entirely with `--no-secrets`.
  const secretFindings = []
  const secretsDisabled = args['no-secrets'] === 'true' || args['no-secrets'] === true
  if (!secretsDisabled) {
    for (const file of sourceFiles) {
      const text = fileText.get(file)
      if (!text) continue
      const lang = languageOf(file) ?? 'any'
      const rel = relative(root, file).replaceAll('\\', '/')
      const hits = scanFileForSecrets({ path: rel, source: text, language: lang })
      for (const h of hits) secretFindings.push(h)
    }
    // Also scan MCP / .env / config files (often store bearer tokens).
    for (const cfg of configHits) {
      try {
        const text = safeRead(cfg.abs)
        if (!text) continue
        const hits = scanFileForSecrets({ path: cfg.rel, source: text, language: 'any' })
        for (const h of hits) secretFindings.push(h)
      } catch { /* read failure non-fatal */ }
    }
  }

  // ── Workflow graph extraction ───────────────────────────────────
  // Walk every source file, pull out workflow topology, and aggregate
  // into a single repo-level graph. The cockpit's policy-generation
  // route uses this graph to write per-node policies.
  const perFileGraphs = []
  for (const file of sourceFiles) {
    const text = fileText.get(file)
    if (!text) continue
    const g = extractWorkflowGraph(text)
    if (g) perFileGraphs.push(g)
  }
  const workflowGraph = perFileGraphs.length > 0
    ? aggregateWorkflowGraphs(perFileGraphs)
    : null

  // ── MCP config candidates ───────────────────────────────────────
  for (const hit of configHits) {
    const servers = detectMcpServers(hit.abs)
    if (servers.length === 0) continue
    for (const server of servers) {
      candidates.push({
        kind: 'mcp',
        path: hit.rel,
        abs_path: hit.abs,
        framework: hit.descriptor.id,
        framework_name: hit.descriptor.context,
        mcp_server: server,
        language: 'config',
        evidence: [{ framework: hit.descriptor.id, server }],
        is_entry_point: false,
        already_protected: false,
        suggested_agent_id: suggestAgentId(meta.repo_name, `${hit.rel}/${server}`),
        remediation: remediationFor('mcp'),
        confidence: 'high',   // config entries are unambiguous
      })
    }
  }

  const ranked = rankCandidates(candidates)

  // Repo-level tool inventory: union of all tools_declared across
  // candidates, plus any MCP-server names. This is what the policy
  // generator grounds on — "policies must reference one of these
  // names." Eliminates the "model invents a tool that doesn't exist"
  // failure mode.
  const toolInventory = new Map()
  for (const c of ranked) {
    for (const t of (c.tools_declared ?? [])) {
      if (!toolInventory.has(t.name)) {
        toolInventory.set(t.name, {
          name: t.name,
          shape: t.shape,
          first_seen_in: c.path,
          sources: [c.path],
        })
      } else {
        const e = toolInventory.get(t.name)
        if (!e.sources.includes(c.path)) e.sources.push(c.path)
      }
    }
    if (c.kind === 'mcp' && c.mcp_server) {
      const key = `mcp:${c.mcp_server}`
      if (!toolInventory.has(key)) {
        toolInventory.set(key, { name: c.mcp_server, shape: 'mcp', first_seen_in: c.path, sources: [c.path] })
      }
    }
  }
  const tool_inventory = [...toolInventory.values()]

  const report = {
    root,
    scanned_at: new Date().toISOString(),
    files_scanned: sourceFiles.length,
    configs_scanned: configHits.length,
    repo: meta,
    tool_inventory,
    candidates: ranked,
    summary: {
      total: ranked.length,
      entry_points: ranked.filter(c => c.is_entry_point).length,
      workflow_entries: ranked.filter(c => c.is_workflow_entry).length,
      already_protected: ranked.filter(c => c.already_protected).length,
      by_kind: ranked.reduce((acc, c) => {
        acc[c.kind] = (acc[c.kind] ?? 0) + 1
        return acc
      }, {}),
      by_framework: ranked.reduce((acc, c) => {
        acc[c.framework] = (acc[c.framework] ?? 0) + 1
        return acc
      }, {}),
      by_confidence: ranked.reduce((acc, c) => {
        const k = c.confidence ?? 'medium'
        acc[k] = (acc[k] ?? 0) + 1
        return acc
      }, {}),
      tools_declared: tool_inventory.length,
      custom_findings: customFindings.length,
      custom_findings_by_severity: customFindings.reduce((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1
        return acc
      }, {}),
      secret_findings: secretFindings.length,
      secret_findings_by_severity: secretFindings.reduce((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1
        return acc
      }, {}),
      // Filter test-fixture matches into a separate counter so an
      // engineer can see "actual production secrets" vs "test fixtures"
      // at a glance without scrolling.
      secret_findings_production: secretFindings.filter(f => !f.is_test).length,
    },
    custom_findings: customFindings,
    custom_rules_loaded: customRules.map(r => ({ id: r.id, severity: r.severity })),
    secret_findings: secretFindings,
    workflow_graph: workflowGraph,
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }

  console.error(`Scanned ${sourceFiles.length} source files and ${configHits.length} config files under ${root}`)
  if (meta.repo_name)  console.error(`Repo: ${meta.repo_name}${meta.version ? '@' + meta.version : ''}`)
  if (meta.owner_email) console.error(`Owner (from CODEOWNERS): ${meta.owner_email}`)
  console.error('')
  if (ranked.length === 0) {
    console.error('No LLM/agent framework usage detected.')
    return
  }
  console.error('CANDIDATES:')
  const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
  console.error(`  ${w('KIND', 6)}  ${w('CONF', 6)}  ${w('FRAMEWORK', 18)}  ${w('ENTRY', 5)}  ${w('PROT', 4)}  PATH`)
  for (const c of ranked) {
    const entry = c.is_workflow_entry ? 'WF' : c.is_entry_point ? 'yes' : ''
    const prot  = c.already_protected ? 'yes' : ''
    const fwLabel = c.kind === 'mcp' ? `${c.framework_name} (${c.mcp_server})` : c.framework_name
    console.error(`  ${w(c.kind, 6)}  ${w(c.confidence, 6)}  ${w(fwLabel, 18)}  ${w(entry, 5)}  ${w(prot, 4)}  ${c.path}`)
  }
  console.error('')
  const k = report.summary.by_kind
  const conf = report.summary.by_confidence
  console.error(`SUMMARY: ${report.summary.total} candidates  (import:${k.import ?? 0} http:${k.http ?? 0} mcp:${k.mcp ?? 0})  ${report.summary.entry_points} entry-points (${report.summary.workflow_entries} workflow) confidence=high:${conf.high ?? 0} medium:${conf.medium ?? 0} low:${conf.low ?? 0}.`)
  process.stdout.write(JSON.stringify(report) + '\n')
}

main(process.argv).catch(err => {
  console.error('scanner crashed:', err?.stack ?? err)
  process.exit(1)
})
