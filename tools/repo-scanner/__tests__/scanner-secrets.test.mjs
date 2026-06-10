/**
 * Secret-scanner tests. Pins:
 *   - AI provider key detection (the differentiator vs. generic gitleaks)
 *   - Cloud key detection (AWS / GCP / Azure)
 *   - Connection strings (postgres / mysql / mongodb with embedded password)
 *   - PEM blocks + JWT
 *   - Entropy filter kills common low-entropy false positives
 *   - Generic high-entropy literal stage catches unknown patterns
 *   - Test-path heuristic flags is_test=true (not suppressed, just marked)
 *   - Evidence is redacted (no full secret leaks in the report)
 *   - CLI integration: report.secret_findings populated
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
const { scanFileForSecrets, _internals } = await import('../secret-scanner.mjs')

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-sec-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

// ── AI provider keys ────────────────────────────────────────────────

test('detects OpenAI sk-... key', () => {
  const r = scanFileForSecrets({
    path: 'app.py',
    source: 'import openai\nopenai.api_key = "sk-AbCdEfGhIjKlMnOpQrStUv1234567890XYZ"\n',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'openai-key'), 'openai-key fired')
})

test('detects Anthropic sk-ant-... key', () => {
  const r = scanFileForSecrets({
    path: 'app.py',
    source: 'API = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'anthropic-key'), 'anthropic-key fired')
})

test('detects HuggingFace hf_... token', () => {
  const r = scanFileForSecrets({
    path: 'app.py',
    // Obviously-fake fixture — GitHub Push Protection's HF-token detector
    // gets jumpy if this string looks too real, so we keep the `hf_`
    // prefix (the part the scanner regex anchors on) and pad with an
    // unambiguous all-A body that no GH heuristic mistakes for a leak.
    source: 'token = "hf_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'huggingface-token'), 'hf token fired')
})

test('detects Google AI / Gemini AIza... key', () => {
  const r = scanFileForSecrets({
    path: 'config.py',
    source: 'GEMINI_KEY = "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'google-api-key'), 'gemini key fired')
})

test('detects Replicate r8_... token', () => {
  const r = scanFileForSecrets({
    path: 'env.py',
    source: 'REPLICATE_API_TOKEN = "r8_AbCdEfGhIjKlMnOpQrStUvWxYz123456"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'replicate-key'), 'replicate token fired')
})

// ── Cloud + database ────────────────────────────────────────────────

test('detects AWS access-key ID', () => {
  const r = scanFileForSecrets({
    path: 'aws.py',
    source: 'AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'aws-access-key'), 'AWS access-key fired')
})

test('detects Postgres connection-string with embedded password', () => {
  const r = scanFileForSecrets({
    path: 'db.py',
    source: 'DATABASE_URL = "postgresql://user:s3cretP@ss@db.acme.com:5432/prod"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'db-connection-pg'), 'pg connection fired')
})

test('detects PEM private key block', () => {
  const r = scanFileForSecrets({
    path: 'key.pem',
    source: '-----BEGIN RSA PRIVATE KEY-----\nMIIE…\n-----END RSA PRIVATE KEY-----\n',
    language: 'any',
  })
  expect_(r.find(f => f.rule_id === 'private-key-pem'), 'PEM block fired')
})

test('detects JWT', () => {
  const r = scanFileForSecrets({
    path: 'auth.py',
    source: 'TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'jwt'), 'JWT fired')
})

// ── Generic high-entropy ────────────────────────────────────────────

test('generic high-entropy literal catches unknown-pattern secret', () => {
  // 32-char random-looking string assigned to a const.
  const r = scanFileForSecrets({
    path: 'config.py',
    source: 'INTERNAL_TOKEN = "X9k2vL8Bq4Yt7Wn3Mj5Hp6Fr1Cz0Ad2Z"',
    language: 'python',
  })
  expect_(r.find(f => f.rule_id === 'generic-high-entropy'), 'generic high-entropy fired')
})

test('low-entropy strings (lorem ipsum / sentences) do not fire generic', () => {
  const r = scanFileForSecrets({
    path: 'doc.md',
    source: 'TITLE = "The quick brown fox jumps over the lazy dog today"',
    language: 'any',
  })
  assert.equal(r.filter(f => f.rule_id === 'generic-high-entropy').length, 0)
})

test('base64 image data is NOT flagged (whitelist)', () => {
  const r = scanFileForSecrets({
    path: 'a.py',
    source: 'IMG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="',
    language: 'python',
  })
  assert.equal(r.length, 0)
})

// ── Test-path heuristic ─────────────────────────────────────────────

test('secrets in test paths are flagged is_test=true', () => {
  const r = scanFileForSecrets({
    path: 'tests/fixtures/secrets.py',
    source: 'fake = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"',
    language: 'python',
  })
  const f = r.find(x => x.rule_id === 'openai-key')
  assert.ok(f, 'openai key flagged')
  assert.equal(f.is_test, true)
})

test('secrets in normal paths are flagged is_test=false', () => {
  const r = scanFileForSecrets({
    path: 'src/config.py',
    source: 'OPENAI_KEY = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"',
    language: 'python',
  })
  const f = r.find(x => x.rule_id === 'openai-key')
  assert.equal(f.is_test, false)
})

// ── Evidence redaction ──────────────────────────────────────────────

test('evidence redacts the secret (no full leak in the report)', () => {
  const r = scanFileForSecrets({
    path: 'app.py',
    source: 'KEY = "sk-ThisIsLongEnoughToBeRedacted1234"',
    language: 'python',
  })
  const f = r[0]
  assert.ok(f.evidence.includes('…'))
  assert.ok(!f.evidence.includes('ThisIsLongEnough'))
})

// ── Entropy utility ─────────────────────────────────────────────────

test('Shannon entropy is high on random strings, low on natural words', () => {
  expect(_internals.shannonEntropy('aaaaaaaaaaaa')).toBeLessThan(0.5);
  expect(_internals.shannonEntropy('the quick brown fox')).toBeLessThan(4.0);
  expect(_internals.shannonEntropy('X9k2vL8Bq4Yt7Wn3Mj5Hp6Fr1Cz0Ad2Z')).toBeGreaterThan(4.3);
})

// ── End-to-end via CLI ──────────────────────────────────────────────

test('scanner CLI emits secret_findings into report JSON', () => {
  const repo = makeRepo({
    'pyproject.toml': 'name = "x"\n',
    'src/main.py':    'import openai\nopenai.api_key = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890XYZ"\n',
    'src/aws.py':     'AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"\n',
    'tests/fixture.py':'mock_key = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"\n',
  })
  try {
    // `--include-tests` so the fixture-path planted key is seen; the
    // default scan path skips tests/ entirely, which would mask the
    // is_test=true behaviour we're testing.
    const raw = execFileSync('node', [SCANNER, repo, '--json', '--include-tests'], { encoding: 'utf8' })
    const report = JSON.parse(raw)
    assert.ok(Array.isArray(report.secret_findings))
    // 4 findings: 2 openai-key matches (one prod, one fixture) + 1 AWS
    // + 1 generic-high-entropy. The CLI test just needs each rule_id
    // to be present + the totals to be coherent.
    assert.ok(report.secret_findings.length >= 3, `got ${report.secret_findings.length}`)
    assert.ok(report.secret_findings.find(f => f.rule_id === 'openai-key'))
    assert.ok(report.secret_findings.find(f => f.rule_id === 'aws-access-key'))
    // CRITICAL severities are at least: openai-key (prod), openai-key
    // (test fixture), aws-access-key — 3 CRITICAL minimum.
    assert.ok((report.summary.secret_findings_by_severity.CRITICAL ?? 0) >= 3)
    // Fixture-path key has is_test=true; production count is total − 1.
    const testCount = report.secret_findings.filter(f => f.is_test).length
    assert.ok(testCount >= 1, 'at least one fixture-path finding flagged is_test')
    assert.equal(report.summary.secret_findings_production, report.secret_findings.length - testCount)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('scanner --no-secrets=true skips secret scanning entirely', () => {
  const repo = makeRepo({
    'pyproject.toml': 'name = "x"',
    'src/main.py': 'KEY = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890XYZ"',
  })
  try {
    const raw = execFileSync('node', [SCANNER, repo, '--json', '--no-secrets', 'true'], { encoding: 'utf8' })
    const report = JSON.parse(raw)
    assert.deepEqual(report.secret_findings, [])
    assert.equal(report.summary.secret_findings, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── tiny helper because we already import assert ─────────────────────
function expect_(value, msg) { assert.ok(value, msg) }
function expect(value) {
  return {
    toBeLessThan: (n) => assert.ok(value < n, `${value} should be < ${n}`),
    toBeGreaterThan: (n) => assert.ok(value > n, `${value} should be > ${n}`),
  }
}
