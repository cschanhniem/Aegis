/**
 * Tests for the NL → policy bundle validator. Exercises every part of
 * the validator-in-loop contract:
 *   1. Shape rejection
 *   2. AJV compile failures
 *   3. should_block / should_allow self-test execution
 *   4. DSL light-validation
 *
 * Run:  node --test src/lib/__tests__/policy-validator.test.mjs
 *
 * (We use the compiled validator from src/lib/policy-validator.ts via
 *  tsx so we don't need a separate test toolchain.)
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// Dynamic import via tsx — node --import tsx runs TS straight through.
const { validateBundle } = await import('../policy-validator.ts')

// ── shape rejection ───────────────────────────────────────────────────

test('rejects non-object bundles', () => {
  const r = validateBundle(null)
  assert.equal(r.ok, false)
  assert.ok(r.issues[0].includes('not an object'))
})

test('rejects bundles without policies array', () => {
  const r = validateBundle({ policies: 'oops', dsl: { version: 1, rules: [] } })
  assert.equal(r.ok, false)
  assert.ok(r.issues.some(i => i.includes('policies must be an array')))
})

test('rejects empty policies array', () => {
  const r = validateBundle({ policies: [], dsl: { version: 1, rules: [] } })
  assert.equal(r.ok, false)
  assert.ok(r.issues.some(i => i.includes('at least one policy required')))
})

test('flags missing dsl.version', () => {
  const bundle = {
    policies: [{ id: 'a', name: 'A', risk_level: 'LOW', policy_schema: { type: 'object' }, tests: { should_block: [], should_allow: [] } }],
    dsl: { rules: [] },
  }
  const r = validateBundle(bundle)
  assert.ok(r.issues.some(i => i.includes('dsl.version must be 1')))
})

// ── AJV compile failures ──────────────────────────────────────────────

test('flags policy_schema that does not compile', () => {
  const bundle = {
    policies: [{
      id: 'bad', name: 'B', risk_level: 'LOW',
      // `properties` MUST be an object, not an array — AJV will throw.
      policy_schema: { type: 'object', properties: ['not-an-object'] },
      tests: { should_block: [], should_allow: [] },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some(i => i.includes('does not compile')))
})

// ── self-test execution ───────────────────────────────────────────────

test('happy path: all tests pass → ok=true, score=1', () => {
  const bundle = {
    policies: [{
      id: 'no-shell', name: 'No Shell', risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', not: { pattern: 'rm\\s+-rf' } },
        },
        additionalProperties: true,
      },
      tests: {
        should_block: [
          { tool: 'shell', arguments: { command: 'rm -rf /' } },
        ],
        should_allow: [
          { tool: 'shell', arguments: { command: 'ls -la' } },
        ],
      },
    }],
    dsl: { version: 1, rules: [{ name: 'r1', then: { decision: 'allow' } }] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, true)
  assert.equal(r.score, 1)
  assert.equal(r.issues.length, 0)
  assert.deepEqual(r.testResults[0], {
    policy_id: 'no-shell', block_pass: 1, block_fail: 0, allow_pass: 1, allow_fail: 0,
  })
})

test('false negative: should_block that the schema does NOT block is reported', () => {
  const bundle = {
    policies: [{
      id: 'too-loose', name: 'Too Loose', risk_level: 'HIGH',
      policy_schema: { type: 'object' },   // matches anything — never blocks
      tests: {
        should_block: [{ tool: 'shell', arguments: { command: 'rm -rf /' } }],
        should_allow: [{ tool: 'shell', arguments: { command: 'ls' } }],
      },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, false)
  assert.equal(r.testResults[0].block_fail, 1)
  assert.equal(r.testResults[0].block_pass, 0)
  assert.ok(r.issues.some(i => i.includes('was NOT blocked')))
})

test('false positive: should_allow that the schema blocks is reported', () => {
  const bundle = {
    policies: [{
      id: 'too-strict', name: 'Too Strict', risk_level: 'LOW',
      policy_schema: { type: 'object', properties: { command: { enum: ['ls'] } } },
      tests: {
        should_block: [],
        should_allow: [
          { tool: 'shell', arguments: { command: 'ls' } },
          { tool: 'shell', arguments: { command: 'pwd' } },   // not in enum → blocked
        ],
      },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, false)
  assert.equal(r.testResults[0].allow_fail, 1)
  assert.equal(r.testResults[0].allow_pass, 1)
  assert.ok(r.issues.some(i => i.includes('was BLOCKED')))
})

test('score reflects fraction of tests passing', () => {
  const bundle = {
    policies: [{
      id: 'half', name: 'Half', risk_level: 'LOW',
      policy_schema: { type: 'object', not: { properties: { x: { const: 1 } }, required: ['x'] } },
      tests: {
        // schema blocks {x:1}; allows everything else.
        // 2 of 4 tests will be wrong below.
        should_block: [
          { tool: 't', arguments: { x: 1 } },   // correctly blocked
          { tool: 't', arguments: { x: 2 } },   // WRONG: model said block but schema allows
        ],
        should_allow: [
          { tool: 't', arguments: { y: 'hi' } },// correctly allowed
          { tool: 't', arguments: { x: 1 } },   // WRONG: schema blocks
        ],
      },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, false)
  assert.equal(r.score, 0.5)
})

// ── DSL validation ────────────────────────────────────────────────────

test('flags DSL rule without then.decision', () => {
  const bundle = {
    policies: [{ id: 'a', name: 'A', risk_level: 'LOW', policy_schema: { type: 'object' }, tests: { should_block: [], should_allow: [] } }],
    dsl: { version: 1, rules: [{ name: 'broken', then: { decision: 'YOLO' } }] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some(i => i.includes("invalid decision 'YOLO'")))
})

// ── No-tests fallback ─────────────────────────────────────────────────

test('policy without tests counts as score=1 when other checks pass', () => {
  const bundle = {
    policies: [{ id: 'a', name: 'A', risk_level: 'LOW', policy_schema: { type: 'object' } }],
    dsl: { version: 1, rules: [{ name: 'r', then: { decision: 'allow' } }] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, true)
  assert.equal(r.score, 1)
})

// ── Template-based policies ──────────────────────────────────────────

test('template-based policy: server compiles + self-tests pass', () => {
  const bundle = {
    policies: [{
      id: 'no-shell', name: 'No Shell', risk_level: 'HIGH',
      template: { kind: 'forbid_pattern', field: 'command', pattern: 'rm\\s+-rf' },
      tests: {
        should_block: [{ tool: 'shell', arguments: { command: 'rm -rf /' } }],
        should_allow: [{ tool: 'shell', arguments: { command: 'ls -la' } }],
      },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, true, r.issues.join('; '))
  assert.equal(r.score, 1)
})

test('composite-based policy compiles + multi-field constraint enforced', () => {
  const bundle = {
    policies: [{
      id: 'safe-fetch', name: 'Safe Fetch', risk_level: 'MEDIUM',
      composite: {
        all_of: true,
        templates: [
          { kind: 'require_https', field: 'url' },
          { kind: 'enum_values',   field: 'method', allowed: ['GET', 'HEAD'] },
        ],
      },
      tests: {
        should_block: [
          { tool: 'http', arguments: { url: 'http://x.com', method: 'GET' } },
          { tool: 'http', arguments: { url: 'https://x.com', method: 'POST' } },
        ],
        should_allow: [
          { tool: 'http', arguments: { url: 'https://x.com', method: 'GET' } },
        ],
      },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, true, r.issues.join('; '))
})

test('rejects template with bad kind cleanly (does not crash compiler)', () => {
  const bundle = {
    policies: [{
      id: 'bad-tpl', name: 'Bad', risk_level: 'LOW',
      template: { kind: 'allow_everything', field: 'x' },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some(i => i.includes('template invalid')))
})

test('missing all three (template/composite/policy_schema) is a clean error', () => {
  const bundle = {
    policies: [{ id: 'naked', name: 'Naked', risk_level: 'LOW' }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some(i => i.includes('missing template / composite / policy_schema')))
})

test('composite preferred over template preferred over policy_schema', () => {
  const bundle = {
    policies: [{
      id: 'mixed', name: 'Mixed', risk_level: 'LOW',
      // Composite says GET only. Template says HEAD only. policy_schema says anything.
      // Composite must win → only GET passes should_allow.
      composite: {
        all_of: true,
        templates: [{ kind: 'enum_values', field: 'method', allowed: ['GET'] }],
      },
      template: { kind: 'enum_values', field: 'method', allowed: ['HEAD'] },
      policy_schema: { type: 'object' },
      tests: {
        should_block: [{ tool: 't', arguments: { method: 'POST' } }],
        should_allow: [{ tool: 't', arguments: { method: 'GET' } }],
      },
    }],
    dsl: { version: 1, rules: [] },
  }
  const r = validateBundle(bundle)
  assert.equal(r.ok, true, r.issues.join('; '))
})
