/**
 * Repo scanner tests. Builds tiny synthetic repos in a tmpdir and asserts
 * the scanner picks up exactly what we expect.
 *
 * Run with:  node --test tools/repo-scanner/__tests__/scanner.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCANNER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-scan-'))
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

test('picks up Python anthropic import', () => {
  const repo = makeRepo({
    'pyproject.toml': 'name = "acme-bot"\nversion = "0.1.0"\n',
    'main.py':        'import anthropic\nclient = anthropic.Anthropic()\n',
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.summary.entry_points, 1)
    assert.equal(r.candidates[0].framework, 'anthropic')
    assert.equal(r.candidates[0].language, 'python')
    assert.equal(r.candidates[0].is_entry_point, true)
    assert.equal(r.repo.repo_name, 'acme-bot')
    assert.ok(r.candidates[0].suggested_agent_id.startsWith('acme-bot-'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('picks up JS openai import without Python false positives', () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: '@acme/bot', version: '1.0.0' }),
    'src/index.ts': `
      import OpenAI from 'openai'
      const c = new OpenAI()
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework, 'openai-js')
    assert.equal(r.candidates[0].language, 'javascript')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('skips node_modules, .git, dist, .venv', () => {
  const repo = makeRepo({
    'node_modules/foo/file.js': "import OpenAI from 'openai'\n",
    '.git/HEAD':                'ref: refs/heads/main\n',
    'dist/bundle.js':           "import OpenAI from 'openai'\n",
    '.venv/lib/site.py':        "import openai\n",
    'app.py':                   "import openai\n",
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].path, 'app.py')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('snippet strings in .tsx files are NOT detected as Python imports', () => {
  // Reproduces the cockpit welcome-view.tsx bug: framework example
  // strings inside JSX would trip every Python signature.
  const repo = makeRepo({
    'cockpit.tsx': `
      const SNIPPETS = [
        { snippet: \`import anthropic\nclient = anthropic.Anthropic()\` },
        { snippet: \`from openai import OpenAI\` },
        { snippet: \`from crewai import Agent\` },
        { snippet: \`import boto3\nbedrock = boto3.client("bedrock-runtime")\` },
      ]
      export const X = SNIPPETS
    `,
  })
  try {
    const r = runScan(repo)
    // No JS framework actually imported; Python signatures must be
    // ignored in .tsx files entirely.
    assert.equal(r.summary.total, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('flags already-protected files', () => {
  const repo = makeRepo({
    'main.py': `
      import agentguard
      agentguard.auto("http://localhost:8080", agent_id="x")
      import anthropic
    `,
    'other.py': "import anthropic\n",
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 2)
    assert.equal(r.summary.already_protected, 1)
    const protectedFile = r.candidates.find(c => c.already_protected)
    assert.equal(protectedFile.path, 'main.py')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('reads owner_email from CODEOWNERS', () => {
  const repo = makeRepo({
    '.github/CODEOWNERS': '* sre-team@acme.com\n',
    'main.py':            'import openai\n',
  })
  try {
    const r = runScan(repo)
    assert.equal(r.repo.owner_email, 'sre-team@acme.com')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('LangChain detection across submodules', () => {
  const repo = makeRepo({
    'app.py': "from langchain.agents import AgentExecutor\n",
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].framework, 'langchain')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('multiple frameworks in one file → all listed as evidence, first wins', () => {
  const repo = makeRepo({
    'multi.py': `
      import anthropic
      from openai import OpenAI
      from langchain.agents import AgentExecutor
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].framework, 'anthropic')   // first-declared wins
    const sigs = r.candidates[0].evidence.map(e => e.framework)
    assert.deepEqual(new Set(sigs), new Set(['anthropic', 'openai', 'langchain']))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('test files are skipped by default but included with --include-tests', () => {
  const repo = makeRepo({
    'tests/test_app.py': "import anthropic\n",
    'main.py':           "import openai\n",
  })
  try {
    const def = runScan(repo)
    assert.equal(def.summary.total, 1)
    assert.equal(def.candidates[0].path, 'main.py')

    const inc = runScan(repo, ['--include-tests'])
    assert.equal(inc.summary.total, 2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('produces a suggested_agent_id for every candidate', () => {
  const repo = makeRepo({
    'pyproject.toml':    'name = "research-bot"\n',
    'svc/runner.py':     "import openai\n",
    'svc/worker.py':     "import anthropic\n",
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates.length, 2)
    for (const c of r.candidates) {
      assert.ok(c.suggested_agent_id.length > 0)
      assert.ok(c.suggested_agent_id.startsWith('research-bot-'))
    }
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
