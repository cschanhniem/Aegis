/**
 * AST-backed JavaScript / TypeScript / TSX scanner tests.
 *
 * Pins the contract that the AST stage catches forms the regex stage
 * can't: dynamic import(), require(), constructor calls, scoped
 * packages with subpaths, commented-out imports, string-only matches.
 *
 * Each test skips itself if web-tree-sitter isn't loadable in this
 * env (e.g. minimal sidecar bundles without the optional dep) — same
 * resilience contract as scanner-ast.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE    = dirname(fileURLToPath(import.meta.url))
const SCANNER = resolve(HERE, '..', 'index.mjs')

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-scan-jsast-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}
function runScan(dir, extra = []) {
  const out = execFileSync('node', [SCANNER, dir, '--json', ...extra], { encoding: 'utf8' })
  return JSON.parse(out)
}

const { tryDetectJs } = await import('../ast-js.mjs')
const astReady = (await tryDetectJs('const x = 1\n', '.js')) !== null

// ── Dynamic + require detection (regex misses these) ─────────────────

test('await import("openai") is flagged via AST', { skip: !astReady && 'AST stage unavailable' }, () => {
  const repo = makeRepo({
    'package.json': '{"name":"@acme/bot","version":"1.0.0"}',
    'src/load.mjs': 'async function go() {\n  const m = await import("openai")\n  return m\n}\ngo()\n',
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework, 'openai-js')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('require("openai") in a .cjs file is flagged', { skip: !astReady && 'AST stage unavailable' }, () => {
  const repo = makeRepo({
    'package.json': '{"name":"acme","version":"1.0.0"}',
    'src/llm.cjs':  'const o = require("openai")\nconst c = new o.OpenAI()\n',
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework, 'openai-js')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('constructor call alongside static import yields used=true on AST evidence', { skip: !astReady && 'AST stage unavailable' }, async () => {
  const r = await tryDetectJs(
    'import OpenAI from "openai";\nconst c = new OpenAI();\n', '.js',
  )
  const slot = r.find(x => x.fw === 'openai-js')
  assert.ok(slot, 'openai-js detected')
  assert.equal(slot.used, true)
  assert.ok(slot.evidence.some(e => e.startsWith('constructor:OpenAI')))
})

// ── Negative: regex-misleading inputs ───────────────────────────────

test('commented-out import is ignored by AST', { skip: !astReady && 'AST stage unavailable' }, async () => {
  const r = await tryDetectJs(
    '// import OpenAI from "openai"\n/* import Anthropic from "@anthropic-ai/sdk" */\nconsole.log(1)\n', '.js',
  )
  assert.deepEqual(r, [])
})

test('string literal that happens to look like an import is ignored', { skip: !astReady && 'AST stage unavailable' }, async () => {
  const r = await tryDetectJs(
    'const sample = "import OpenAI from \\"openai\\"";\nconsole.log(sample)\n', '.js',
  )
  assert.deepEqual(r, [])
})

// ── Scoped + subpath imports normalise correctly ────────────────────

test('scoped @langchain/openai resolves to langchain-js framework', { skip: !astReady && 'AST stage unavailable' }, async () => {
  const r = await tryDetectJs(
    'import { ChatOpenAI } from "@langchain/openai";\nconst c = new ChatOpenAI();\n', '.ts',
  )
  const slot = r.find(x => x.fw === 'langchain-js')
  assert.ok(slot, 'langchain-js detected via scoped import')
  assert.equal(slot.used, true)
})

test('subpath require ("cohere-ai/v7/something") still resolves to cohere-js', { skip: !astReady && 'AST stage unavailable' }, async () => {
  const r = await tryDetectJs(
    'const c = require("cohere-ai/v7/something")\n', '.cjs',
  )
  assert.ok(r.find(x => x.fw === 'cohere-js'))
})

// ── TypeScript / TSX grammar selection ──────────────────────────────

test('TypeScript file with type annotations parses and flags openai', { skip: !astReady && 'AST stage unavailable' }, async () => {
  const r = await tryDetectJs(
    'import OpenAI from "openai";\nconst c: OpenAI = new OpenAI();\nexport default c;\n', '.ts',
  )
  assert.ok(r.find(x => x.fw === 'openai-js'))
})

test('TSX file with JSX + import resolves correctly', { skip: !astReady && 'AST stage unavailable' }, async () => {
  const r = await tryDetectJs(
    `import OpenAI from "openai";\nexport const C = () => <div>{new OpenAI().toString()}</div>;\n`, '.tsx',
  )
  assert.ok(r.find(x => x.fw === 'openai-js'))
})

// ── End-to-end scan picks up AST evidence in the candidate ──────────

test('e2e: scan a JS repo with only-dynamic-import detects it', { skip: !astReady && 'AST stage unavailable' }, () => {
  const repo = makeRepo({
    'package.json': '{"name":"acme","version":"1.0.0"}',
    'src/index.js': `
      module.exports = async () => {
        const Anthropic = (await import("@anthropic-ai/sdk")).default
        return new Anthropic()
      }
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework, 'anthropic-js')
    assert.equal(r.candidates[0].language, 'javascript')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
