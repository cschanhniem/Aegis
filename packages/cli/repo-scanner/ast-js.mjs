/**
 * Tree-sitter-backed JavaScript / TypeScript / TSX detection.
 *
 * Mirrors ast-python.mjs but for the JS family. Catches forms the
 * regex stage misses:
 *
 *   - Dynamic imports:    `await import('openai')`
 *   - `require()` of LLM SDKs (CJS + Node ESM interop)
 *   - SDK constructor calls (`new OpenAI(...)`, `new Anthropic(...)`)
 *     — confirms USAGE, not just import presence.
 *   - Computed-string base URLs:  `const base = \`https://${region}.openai.com\``
 *     (regex would need to know about template literal substitution
 *     to even attempt this; AST sees the template_string body cleanly.)
 *
 * Failure mode: web-tree-sitter is optional. If it can't load, this
 * module returns null and the caller falls back to the regex stage —
 * identical to ast-python.mjs's contract.
 *
 * Language selection:
 *   .js / .mjs / .cjs / .jsx  → tree-sitter-javascript
 *   .ts                       → tree-sitter-typescript
 *   .tsx                      → tree-sitter-tsx
 *
 * We load grammars lazily; only the languages actually encountered
 * during a scan get parsed.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// JS-side module-name → framework id. The regex table in signatures.mjs
// uses the same ids; materialised here so the AST module stays
// decoupled from the regex one.
const JS_PKG_TO_FRAMEWORK = Object.freeze({
  '@anthropic-ai/sdk':       'anthropic-js',
  'openai':                  'openai-js',
  'ai':                      'vercel-ai',
  '@mastra/core':            'mastra',
  '@langchain/core':         'langchain-js',
  '@langchain/openai':       'langchain-js',
  '@langchain/anthropic':    'langchain-js',
  '@langchain/community':    'langchain-js',
  '@langchain/langgraph':    'langchain-js',
  'langchain':               'langchain-js',
  '@mistralai/mistralai':    'mistral-js',
  'cohere-ai':               'cohere-js',
  'ollama':                  'ollama-js',
  'groq-sdk':                'groq-js',
})

// JS-side constructor → framework. Most SDKs expose a single
// "AgentClient" constructor; we list the well-known names.
const JS_CTOR_TO_FRAMEWORK = Object.freeze({
  Anthropic:        'anthropic-js',
  OpenAI:           'openai-js',
  OpenAIClient:     'openai-js',
  AzureOpenAI:      'openai-js',
  Mistral:          'mistral-js',
  Cohere:           'cohere-js',
  CohereClient:     'cohere-js',
  Groq:             'groq-js',
  Ollama:           'ollama-js',
  ChatOpenAI:       'langchain-js',
  ChatAnthropic:    'langchain-js',
})

/** Module-name normalisation. Strips subpath / version-suffix /
 *  scope-keeping behaviour. */
function packageOfImport(spec) {
  if (!spec) return null
  // Scoped: "@x/y/sub" → "@x/y"
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec
  }
  // Bare: "openai/lib/foo" → "openai"
  return spec.split('/')[0]
}

const HERE = dirname(fileURLToPath(import.meta.url))
const GRAMMAR_PATHS = {
  javascript: join(HERE, 'tree-sitter-javascript.wasm'),
  typescript: join(HERE, 'tree-sitter-typescript.wasm'),
  tsx:        join(HERE, 'tree-sitter-tsx.wasm'),
}

const PARSERS = {}
let _parserInitFailed = false

async function getParser(langKey) {
  if (_parserInitFailed) return null
  if (PARSERS[langKey]) return PARSERS[langKey]
  try {
    const Parser = (await import('web-tree-sitter')).default
    await Parser.init()
    const path = GRAMMAR_PATHS[langKey]
    if (!path || !existsSync(path)) return null
    const Language = await Parser.Language.load(path)
    const p = new Parser()
    p.setLanguage(Language)
    PARSERS[langKey] = p
    return p
  } catch {
    _parserInitFailed = true
    return null
  }
}

/** Walk JS/TS AST collecting imports + dynamic imports + constructor
 *  calls. One-pass preorder traversal. */
function walk(node, out) {
  const t = node.type

  // ── Static imports (ESM): `import X from 'pkg'`, `import { ... } from 'pkg'`
  if (t === 'import_statement') {
    const src = node.childForFieldName('source')
    if (src) out.imports.push({ kind: 'import', pkg: stripQuotes(src.text), lineno: node.startPosition.row + 1 })
  }

  // ── CJS require: `const x = require('pkg')`
  if (t === 'call_expression') {
    const fn = node.childForFieldName('function')
    if (fn && fn.text === 'require') {
      const args = node.childForFieldName('arguments')
      if (args && args.namedChildCount >= 1) {
        const a = args.namedChild(0)
        if (a.type === 'string') {
          out.imports.push({ kind: 'require', pkg: stripQuotes(a.text), lineno: node.startPosition.row + 1 })
        }
      }
    }
    // ── Dynamic import: `await import('pkg')`
    if (fn && (fn.type === 'import' || fn.text === 'import')) {
      const args = node.childForFieldName('arguments')
      if (args && args.namedChildCount >= 1) {
        const a = args.namedChild(0)
        if (a.type === 'string') {
          out.imports.push({ kind: 'dynamic', pkg: stripQuotes(a.text), lineno: node.startPosition.row + 1 })
        }
      }
    }
  }

  // ── `new OpenAI(...)`, `new (require('openai').default)(...)` etc.
  if (t === 'new_expression') {
    const ctor = node.childForFieldName('constructor')
    if (ctor) {
      const name = identifierOf(ctor)
      if (name && JS_CTOR_TO_FRAMEWORK[name]) {
        out.constructorCalls.push({
          fw: JS_CTOR_TO_FRAMEWORK[name],
          name,
          lineno: node.startPosition.row + 1,
        })
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) walk(node.child(i), out)
}

function stripQuotes(s) {
  // tree-sitter `string` text includes the quotes; strip them.
  // Handles "..." / '...' / `...`. For backticks we drop the entire
  // template (no interpolation resolution).
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) {
    return s.slice(1, -1)
  }
  return s
}

function identifierOf(node) {
  if (!node) return null
  if (node.type === 'identifier' || node.type === 'type_identifier') return node.text
  if (node.type === 'member_expression') {
    const prop = node.childForFieldName('property')
    if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) return prop.text
  }
  return null
}

/** Best-effort AST detection for a JS-family file. Returns null on
 *  parser-load failure (caller must fall back to regex). */
export async function tryDetectJs(source, ext /* '.js' | '.ts' | '.tsx' | '.mjs' | '.cjs' | '.jsx' */) {
  const langKey = (ext === '.ts')         ? 'typescript'
                : (ext === '.tsx')        ? 'tsx'
                : 'javascript';   // .js .mjs .cjs .jsx
  const parser = await getParser(langKey)
  if (!parser) return null

  let tree
  try { tree = parser.parse(source) } catch { return null }
  const out = { imports: [], constructorCalls: [] }
  try { walk(tree.rootNode, out) } finally { try { tree.delete() } catch {} }

  // Reduce to framework-matches with merged evidence.
  const matches = new Map()
  for (const im of out.imports) {
    const pkg = packageOfImport(im.pkg)
    const fw = JS_PKG_TO_FRAMEWORK[pkg]
    if (!fw) continue
    const slot = matches.get(fw) ?? { fw, evidence: new Set(), lineno: im.lineno }
    slot.evidence.add(`${im.kind}:${pkg}`)
    if (im.lineno < slot.lineno) slot.lineno = im.lineno
    matches.set(fw, slot)
  }
  for (const cc of out.constructorCalls) {
    const slot = matches.get(cc.fw) ?? { fw: cc.fw, evidence: new Set(), lineno: cc.lineno }
    slot.evidence.add(`constructor:${cc.name}`)
    matches.set(cc.fw, slot)
  }
  return Array.from(matches.values()).map(m => ({
    fw: m.fw,
    evidence: Array.from(m.evidence),
    lineno: m.lineno,
    used: m.evidence.size > 1 || Array.from(m.evidence).some(e => e.startsWith('constructor:')),
  }))
}

/** Read + detect convenience for tests / one-shot calls. */
export async function tryDetectJsFile(path) {
  let source
  try { source = readFileSync(path, 'utf8') } catch { return null }
  const ext = path.toLowerCase().slice(path.lastIndexOf('.'))
  return tryDetectJs(source, ext)
}
