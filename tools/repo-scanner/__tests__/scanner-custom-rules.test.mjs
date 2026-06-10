/**
 * Custom scan rules — YAML/JSON rule loading + application tests.
 *
 * Pins the documented rule shape (regex, ast, tool_call matchers) and
 * the safe-fail behaviour (invalid rules warn but never crash the scan).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCANNER = resolve(HERE, '..', 'index.mjs')
const { loadRules, applyRules } = await import('../custom-rules.mjs')

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rules-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}
function makeRulesDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rules-dir-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return dir
}

// ── Loader ───────────────────────────────────────────────────────────

test('loadRules: parses minimal YAML rule shape', () => {
  const dir = makeRulesDir({
    'a.yaml': `rules:
  - id: acme.test
    severity: HIGH
    message: probe
    match:
      regex: 'forbidden_pattern'
`,
  })
  try {
    const { rules, warnings } = loadRules(dir)
    assert.equal(warnings.length, 0)
    assert.equal(rules.length, 1)
    assert.equal(rules[0].id, 'acme.test')
    assert.equal(rules[0].severity, 'HIGH')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadRules: parses JSON rule files', () => {
  const dir = makeRulesDir({
    'r.json': JSON.stringify({
      rules: [{ id: 'j1', severity: 'LOW', message: 'x', match: { regex: 'foo' } }],
    }),
  })
  try {
    const { rules, warnings } = loadRules(dir)
    assert.equal(warnings.length, 0)
    assert.equal(rules[0].id, 'j1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadRules: skips invalid rules with warning, keeps valid ones', () => {
  const dir = makeRulesDir({
    'mixed.yaml': `rules:
  - id: good
    severity: HIGH
    message: yes
    match:
      regex: 'x'
  - id: bad-no-match
    severity: HIGH
    message: y
  - id: bad-regex
    severity: HIGH
    message: z
    match:
      regex: '[unclosed'
`,
  })
  try {
    const { rules, warnings } = loadRules(dir)
    assert.equal(rules.length, 1)
    assert.equal(rules[0].id, 'good')
    assert.ok(warnings.some(w => w.includes('bad-no-match')))
    assert.ok(warnings.some(w => w.includes('bad-regex')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadRules: rejects unknown severity / language', () => {
  const dir = makeRulesDir({
    'r.yaml': `rules:
  - id: bad-sev
    severity: ZZZ
    message: x
    match:
      regex: 'x'
  - id: bad-lang
    severity: LOW
    message: y
    languages: [ocaml]
    match:
      regex: 'x'
`,
  })
  try {
    const { rules, warnings } = loadRules(dir)
    assert.equal(rules.length, 0)
    assert.ok(warnings.some(w => w.includes('invalid severity')))
    assert.ok(warnings.some(w => w.includes('invalid language')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadRules: nonexistent directory returns empty array silently', () => {
  const { rules, warnings } = loadRules('/nonexistent/path/here')
  assert.deepEqual(rules, [])
  assert.deepEqual(warnings, [])
})

// ── Application ──────────────────────────────────────────────────────

test('applyRules: regex matcher fires on source content + reports line', () => {
  const rules = [{
    id: 'r', severity: 'HIGH', message: 'has secret', languages: ['python'],
    match: { regex: 'sk_live_[A-Za-z0-9]{8,}' },
  }]
  const findings = applyRules(rules, {
    path: 'a.py', language: 'python',
    source: 'x = "hi"\ny = "sk_live_AAAAAAAA"\nprint(y)\n',
    astHints: {},
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule_id, 'r')
  assert.equal(findings[0].line, 2)
  assert.ok(findings[0].evidence.startsWith('sk_live_'))
})

test('applyRules: language filter excludes mismatched files', () => {
  const rules = [{
    id: 'py-only', severity: 'HIGH', message: 'x', languages: ['python'],
    match: { regex: 'forbidden' },
  }]
  const onJs = applyRules(rules, {
    path: 'a.js', language: 'javascript',
    source: 'const forbidden = 1', astHints: {},
  })
  assert.equal(onJs.length, 0)
})

test('applyRules: any-language rule matches every file', () => {
  const rules = [{
    id: 'any', severity: 'LOW', message: 'x', languages: ['any'],
    match: { regex: 'TODO' },
  }]
  const onPy = applyRules(rules, { path: 'a.py', language: 'python', source: '# TODO\n', astHints: {} })
  const onJs = applyRules(rules, { path: 'a.js', language: 'javascript', source: '// TODO\n', astHints: {} })
  assert.equal(onPy.length, 1)
  assert.equal(onJs.length, 1)
})

test('applyRules: tool_call matcher fires when astHints carries tool calls', () => {
  const rules = [{
    id: 'no-legacy', severity: 'MEDIUM', message: 'deprecated',
    languages: ['python'],
    match: { tool_call: { name: 'legacy_query' } },
  }]
  const findings = applyRules(rules, {
    path: 'a.py', language: 'python', source: 'x = 1\n',
    astHints: {
      toolCalls: [
        { name: 'legacy_query', argsText: 'SELECT * FROM x', line: 5 },
        { name: 'safe_query', argsText: 'SELECT 1', line: 6 },
      ],
    },
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule_id, 'no-legacy')
})

test('applyRules: tool_call arg_pattern narrows match', () => {
  const rules = [{
    id: 'no-secrets-in-prompt', severity: 'CRITICAL', message: 'leak',
    languages: ['any'],
    match: { tool_call: { name: 'chat_completion', arg_pattern: 'sk_live_[A-Za-z0-9_]{8,}' } },
  }]
  const benign = applyRules(rules, {
    path: 'a.py', language: 'python', source: '',
    astHints: { toolCalls: [{ name: 'chat_completion', argsText: 'hello world', line: 1 }] },
  })
  assert.equal(benign.length, 0)
  const leak = applyRules(rules, {
    path: 'a.py', language: 'python', source: '',
    astHints: { toolCalls: [{ name: 'chat_completion', argsText: 'sk_live_AAAAAAAA in prompt', line: 4 }] },
  })
  assert.equal(leak.length, 1)
})

// ── End-to-end via the scanner CLI ───────────────────────────────────

test('scanner --rules <dir> writes custom_findings into report JSON', () => {
  const rulesDir = makeRulesDir({
    'r.yaml': `rules:
  - id: acme.no-aws-key
    severity: CRITICAL
    message: AWS access-key id detected
    languages: [any]
    match:
      regex: 'AKIA[0-9A-Z]{16}'
`,
  })
  const repo = makeRepo({
    'pyproject.toml': 'name = "x"',
    'src/leak.py': 'import os\nKEY = "AKIA1234567890ABCDEF"\nprint(KEY)\n',
  })
  try {
    const raw = execFileSync(
      'node',
      [SCANNER, repo, '--json', '--rules', rulesDir],
      { encoding: 'utf8' },
    )
    const report = JSON.parse(raw)
    assert.ok(Array.isArray(report.custom_findings))
    assert.equal(report.custom_findings.length, 1)
    assert.equal(report.custom_findings[0].rule_id, 'acme.no-aws-key')
    assert.equal(report.custom_findings[0].severity, 'CRITICAL')
    assert.equal(report.summary.custom_findings, 1)
    assert.equal(report.summary.custom_findings_by_severity.CRITICAL, 1)
    assert.ok(Array.isArray(report.custom_rules_loaded))
    assert.equal(report.custom_rules_loaded[0].id, 'acme.no-aws-key')
  } finally {
    rmSync(rulesDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('scanner runs without --rules unchanged (backwards-compat)', () => {
  const repo = makeRepo({
    'pyproject.toml': 'name = "x"',
    'src/app.py': 'import anthropic\nc = anthropic.Anthropic()\n',
  })
  try {
    const raw = execFileSync('node', [SCANNER, repo, '--json'], { encoding: 'utf8' })
    const report = JSON.parse(raw)
    // Existing behaviour intact + custom_findings is present but empty.
    assert.equal(report.summary.total, 1)
    assert.equal(report.summary.custom_findings, 0)
    assert.deepEqual(report.custom_findings, [])
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
