/**
 * Tree-sitter-backed Python detection.
 *
 * Why this exists (vs the regex stage):
 *   1. Catches forms the regex misses:
 *        - importlib.import_module("anthropic")
 *        - __import__("openai")
 *        - SDK constructor calls (anthropic.Anthropic(), OpenAI(...))
 *      Constructor detection lifts confidence ("this file actually USES
 *      the SDK, not just imports a sibling that happens to share a
 *      prefix").
 *   2. Eliminates one whole class of false positives the blank-out
 *      preprocessor can't reach — string-formed imports inside dynamic
 *      code paths that the blanker leaves intact because they're not
 *      pure literals.
 *
 * Failure mode:
 *   web-tree-sitter is an OPTIONAL dependency. We dynamic-import it on
 *   first use. If it isn't available (e.g. the desktop sidecar bundle,
 *   which copies only .mjs files and no node_modules), `tryDetect()`
 *   returns null and the caller falls back to the existing regex stage
 *   — same observable behaviour as before this module existed.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Python module name (or dotted prefix) → framework id. Matches the
// table in signatures.mjs but materialised here because AST detection
// works on identifiers, not patterns.
const PY_MODULE_TO_FRAMEWORK = Object.freeze({
  anthropic:                     'anthropic',
  openai:                        'openai',
  langchain:                     'langchain',
  langchain_core:                'langchain',
  langchain_community:           'langchain',
  langchain_openai:              'langchain',
  langchain_anthropic:           'langchain',
  langgraph:                     'langgraph',
  crewai:                        'crewai',
  llama_index:                   'llamaindex',
  mistralai:                     'mistral',
  smolagents:                    'smolagents',
  pydantic_ai:                   'pydantic-ai',
  autogen:                       'autogen',
  haystack:                      'haystack',
  dspy:                          'dspy',
  cohere:                        'cohere',
  together:                      'together',
  ollama:                        'ollama',
  groq:                          'groq',
  replicate:                     'replicate',
  // google.generativeai is a dotted-prefix match; tested specially below.
})

// Constructor identifier (per Python SDK convention) → framework id.
// Used to confirm SDK usage, not just module presence.
const PY_CONSTRUCTOR_TO_FRAMEWORK = Object.freeze({
  Anthropic:       'anthropic',
  AsyncAnthropic:  'anthropic',
  OpenAI:          'openai',
  AsyncOpenAI:     'openai',
  AzureOpenAI:     'openai',
  Mistral:         'mistral',
  Cohere:          'cohere',
  Groq:            'groq',
})

const WASM_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'tree-sitter-python.wasm',
)

let _parser = null
let _initFailed = false

async function initParser() {
  if (_parser) return _parser
  if (_initFailed) return null
  try {
    const Parser = (await import('web-tree-sitter')).default
    await Parser.init()
    if (!existsSync(WASM_PATH)) { _initFailed = true; return null }
    const Python = await Parser.Language.load(WASM_PATH)
    const p = new Parser()
    p.setLanguage(Python)
    _parser = p
    return _parser
  } catch {
    _initFailed = true
    return null
  }
}

/** Resolve a dotted import path (e.g. "langchain_openai.chat_models") to
 *  a framework id by checking the leftmost matching segment. */
function frameworkOfModulePath(modulePath) {
  if (!modulePath) return null
  const head = modulePath.split('.')[0]
  if (PY_MODULE_TO_FRAMEWORK[head]) return PY_MODULE_TO_FRAMEWORK[head]
  // Special-case google.generativeai (the only multi-segment alias).
  if (modulePath.startsWith('google.generativeai')) return 'gemini'
  if (modulePath === 'google' || modulePath.startsWith('google.')) {
    // Watch for "from google import genai"
    if (modulePath === 'google') return 'gemini-maybe'
  }
  return null
}

/** Walk AST collecting:
 *   - imports         {kind:'import'|'from'|'dynamic', module, lineno}
 *   - constructorCalls {fw, lineno}
 *  Single linear pass over child nodes (no per-pattern queries — fewer
 *  WASM round-trips). */
function walk(node, out) {
  const t = node.type

  if (t === 'import_statement') {
    // `import a, b.c as alias`
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)
      if (c.type === 'dotted_name' || c.type === 'aliased_import') {
        const dn = c.type === 'dotted_name' ? c : c.childForFieldName('name')
        if (dn) out.imports.push({ kind: 'import', module: dn.text, lineno: c.startPosition.row + 1 })
      }
    }
  } else if (t === 'import_from_statement') {
    const mod = node.childForFieldName('module_name')
    if (mod) out.imports.push({ kind: 'from', module: mod.text, lineno: node.startPosition.row + 1 })
  } else if (t === 'call') {
    const fn = node.childForFieldName('function')
    if (fn) {
      const fnText = fn.text
      // importlib.import_module("anthropic")  |  __import__("openai")
      if (fnText === 'importlib.import_module' || fnText === '__import__') {
        const args = node.childForFieldName('arguments')
        if (args) {
          for (let i = 0; i < args.namedChildCount; i++) {
            const a = args.namedChild(i)
            if (a.type === 'string') {
              const lit = a.text.slice(1, -1)   // strip quotes
              if (lit) out.imports.push({ kind: 'dynamic', module: lit, lineno: node.startPosition.row + 1 })
            }
          }
        }
      } else {
        // Constructor identifier on the right of attribute access, OR
        // a bare identifier on the left side of the call.
        let identName = null
        if (fn.type === 'identifier') identName = fnText
        else if (fn.type === 'attribute') {
          const attr = fn.childForFieldName('attribute')
          if (attr && attr.type === 'identifier') identName = attr.text
        }
        if (identName && PY_CONSTRUCTOR_TO_FRAMEWORK[identName]) {
          out.constructorCalls.push({
            fw: PY_CONSTRUCTOR_TO_FRAMEWORK[identName],
            name: identName,
            lineno: node.startPosition.row + 1,
          })
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) walk(node.child(i), out)
}

/** Best-effort AST detection. Returns null if tree-sitter isn't loadable;
 *  caller MUST fall back to the regex stage in that case. */
export async function tryDetectPython(source) {
  const parser = await initParser()
  if (!parser) return null
  let tree
  try { tree = parser.parse(source) } catch { return null }
  const out = { imports: [], constructorCalls: [] }
  try { walk(tree.rootNode, out) } finally { try { tree.delete() } catch {} }

  // Map imports + dynamic imports → framework matches.
  const matches = new Map()   // fw -> { fw, evidence: Set<string>, lineno }
  for (const im of out.imports) {
    let fw = frameworkOfModulePath(im.module)
    if (fw === 'gemini-maybe') continue   // only positive on "google.generativeai"
    if (fw) {
      const m = matches.get(fw) ?? { fw, evidence: new Set(), lineno: im.lineno }
      const tag = im.kind === 'dynamic' ? `dynamic:${im.module}` : `${im.kind}:${im.module}`
      m.evidence.add(tag)
      if (im.lineno < m.lineno) m.lineno = im.lineno
      matches.set(fw, m)
    }
  }
  for (const cc of out.constructorCalls) {
    const m = matches.get(cc.fw) ?? { fw: cc.fw, evidence: new Set(), lineno: cc.lineno }
    m.evidence.add(`constructor:${cc.name}`)
    matches.set(cc.fw, m)
  }
  return Array.from(matches.values()).map(m => ({
    fw: m.fw,
    evidence: Array.from(m.evidence),
    lineno: m.lineno,
    used:    m.evidence.size > 1 || Array.from(m.evidence).some(e => e.startsWith('constructor:')),
  }))
}

/** Convenience: read + detect. Pure utility for tests / one-shot calls. */
export async function tryDetectPythonFile(path) {
  let source
  try { source = readFileSync(path, 'utf8') } catch { return null }
  return tryDetectPython(source)
}
