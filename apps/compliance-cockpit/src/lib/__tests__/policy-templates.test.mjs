/**
 * Tests for the policy-templates module — the grammar-constrained
 * generation foundation.
 *
 * We assert two complementary contracts:
 *   1. Zod validation: well-formed templates parse; malformed ones reject.
 *   2. compileTemplate produces JSON Schema that AJV actually accepts AND
 *      that semantically blocks/allows the values it should.
 *
 * Run:  node --import tsx --test src/lib/__tests__/policy-templates.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false })

const {
  PolicyTemplateSchema,
  CompositeTemplateSchema,
  TemplatePolicySchema,
  compileTemplate,
  describeTemplate,
  describeComposite,
  describePolicy,
} = await import('../policy-templates.ts')

// helper: compile a template into an AJV validator we can call repeatedly
function buildValidator(input) {
  const schema = compileTemplate(input)
  return { schema, validate: ajv.compile(schema) }
}

// ── 1. Zod schema validation ──────────────────────────────────────────

test('PolicyTemplateSchema accepts each of the 6 single-template kinds', () => {
  const ok = [
    { kind: 'forbid_argument', field: 'cmd' },
    { kind: 'require_pattern', field: 'url', pattern: '^https://api\\.example\\.com/' },
    { kind: 'forbid_pattern',  field: 'sql', pattern: 'DROP\\s+TABLE' },
    { kind: 'max_length',      field: 'note', max: 1024 },
    { kind: 'enum_values',     field: 'method', allowed: ['GET', 'HEAD'] },
    { kind: 'require_https',   field: 'callback_url' },
  ]
  for (const t of ok) assert.equal(PolicyTemplateSchema.safeParse(t).success, true, `kind=${t.kind}`)
})

test('PolicyTemplateSchema rejects unknown kind', () => {
  const r = PolicyTemplateSchema.safeParse({ kind: 'allow_everything', field: 'x' })
  assert.equal(r.success, false)
})

test('PolicyTemplateSchema rejects invalid field identifier', () => {
  const r = PolicyTemplateSchema.safeParse({ kind: 'forbid_argument', field: '1starts-digit' })
  assert.equal(r.success, false)
})

test('PolicyTemplateSchema rejects unknown extra keys (.strict)', () => {
  const r = PolicyTemplateSchema.safeParse({ kind: 'max_length', field: 'x', max: 10, bonus: 'no' })
  assert.equal(r.success, false)
})

test('PolicyTemplateSchema rejects enum_values with no allowed list', () => {
  const r = PolicyTemplateSchema.safeParse({ kind: 'enum_values', field: 'm', allowed: [] })
  assert.equal(r.success, false)
})

test('CompositeTemplateSchema requires at least one sub-template', () => {
  const r = CompositeTemplateSchema.safeParse({ templates: [] })
  assert.equal(r.success, false)
})

test('CompositeTemplateSchema rejects > 8 sub-templates (DoS guard)', () => {
  const tpls = Array.from({ length: 9 }, (_, i) => ({ kind: 'max_length', field: `f${i}`, max: 10 }))
  const r = CompositeTemplateSchema.safeParse({ templates: tpls })
  assert.equal(r.success, false)
})

test('TemplatePolicySchema requires kebab-case id', () => {
  const r = TemplatePolicySchema.safeParse({
    id: 'NotKebab',
    name: 'X',
    risk_level: 'LOW',
    template: { kind: 'forbid_argument', field: 'x' },
  })
  assert.equal(r.success, false)
})

test('TemplatePolicySchema accepts a kebab-case minimal policy', () => {
  const r = TemplatePolicySchema.safeParse({
    id: 'no-shell',
    name: 'No shell',
    risk_level: 'HIGH',
    template: { kind: 'forbid_argument', field: 'cmd' },
  })
  assert.equal(r.success, true)
})

// ── 2. compileTemplate → AJV runtime behaviour ────────────────────────

test('forbid_argument: any non-empty value rejected, missing field accepted', () => {
  const { validate } = buildValidator({ kind: 'forbid_argument', field: 'cmd' })
  assert.equal(validate({ cmd: 'rm -rf /' }), false)
  assert.equal(validate({ cmd: '' }), true)            // length-0 string allowed
  assert.equal(validate({}), true)                     // forbid_argument does NOT make field required
  assert.equal(validate({ other: 'ok' }), true)
})

test('require_pattern: matching string accepted, non-matching rejected, field required', () => {
  const { validate } = buildValidator({
    kind: 'require_pattern', field: 'url',
    pattern: '^https://api\\.example\\.com/',
  })
  assert.equal(validate({ url: 'https://api.example.com/v1' }), true)
  assert.equal(validate({ url: 'http://evil.com' }), false)
  assert.equal(validate({}), false)                    // require_pattern enforces required
})

test('forbid_pattern: matching string rejected, non-matching accepted', () => {
  const { validate } = buildValidator({
    kind: 'forbid_pattern', field: 'sql', pattern: 'DROP\\s+TABLE',
  })
  assert.equal(validate({ sql: 'SELECT * FROM t' }), true)
  assert.equal(validate({ sql: 'DROP TABLE users' }), false)
  assert.equal(validate({ sql: 'DROP    TABLE x' }), false)
  assert.equal(validate({}), true)                     // forbid_pattern does NOT require field
})

test('max_length: enforces upper bound exactly', () => {
  const { validate } = buildValidator({ kind: 'max_length', field: 'note', max: 5 })
  assert.equal(validate({ note: 'hello' }), true)
  assert.equal(validate({ note: 'hello!' }), false)
  assert.equal(validate({ note: '' }), true)
  assert.equal(validate({}), true)
})

test('enum_values: only allowed values pass, field required', () => {
  const { validate } = buildValidator({
    kind: 'enum_values', field: 'method', allowed: ['GET', 'HEAD'],
  })
  assert.equal(validate({ method: 'GET' }), true)
  assert.equal(validate({ method: 'POST' }), false)
  assert.equal(validate({}), false)
})

test('enum_values: heterogeneous allowed list works (string|number|bool)', () => {
  const { validate } = buildValidator({
    kind: 'enum_values', field: 'flag', allowed: [true, 0, 'off'],
  })
  assert.equal(validate({ flag: true }), true)
  assert.equal(validate({ flag: 0 }), true)
  assert.equal(validate({ flag: 'off' }), true)
  assert.equal(validate({ flag: false }), false)
})

test('require_https: only https:// URLs accepted, field required', () => {
  const { validate } = buildValidator({ kind: 'require_https', field: 'callback' })
  assert.equal(validate({ callback: 'https://x.com/cb' }), true)
  assert.equal(validate({ callback: 'http://x.com/cb' }), false)
  assert.equal(validate({}), false)
})

// ── 3. Composite compilation ──────────────────────────────────────────

test('composite all_of: multiple constraints on different fields, all enforced', () => {
  const { validate } = buildValidator({
    all_of: true,
    templates: [
      { kind: 'require_https', field: 'url' },
      { kind: 'enum_values',   field: 'method', allowed: ['GET', 'HEAD'] },
    ],
  })
  assert.equal(validate({ url: 'https://x.com', method: 'GET' }), true)
  assert.equal(validate({ url: 'http://x.com',  method: 'GET' }), false)   // url fails
  assert.equal(validate({ url: 'https://x.com', method: 'POST' }), false)  // method fails
  assert.equal(validate({ url: 'https://x.com' }), false)                  // method missing
})

test('composite all_of: multiple constraints on SAME field fold into allOf', () => {
  const { schema, validate } = buildValidator({
    all_of: true,
    templates: [
      { kind: 'require_pattern', field: 'url', pattern: '^https://' },
      { kind: 'max_length',      field: 'url', max: 50 },
    ],
  })
  // Verify schema folds into allOf for the field
  assert.ok(schema.properties.url.allOf, 'should fold same-field templates into allOf')
  assert.equal(validate({ url: 'https://short.com' }), true)
  assert.equal(validate({ url: 'http://short.com' }), false)
  const long = 'https://' + 'a'.repeat(60)
  assert.equal(validate({ url: long }), false)
})

test('composite all_of=false produces anyOf for same-field constraints', () => {
  const { schema, validate } = buildValidator({
    all_of: false,
    templates: [
      { kind: 'enum_values',     field: 'mode', allowed: ['safe'] },
      { kind: 'require_pattern', field: 'mode', pattern: '^debug-' },
    ],
  })
  assert.ok(schema.properties.mode.anyOf, 'same-field constraints under any → anyOf')
  assert.equal(validate({ mode: 'safe' }), true)
  assert.equal(validate({ mode: 'debug-1' }), true)
  assert.equal(validate({ mode: 'reckless' }), false)
})

test('composite required[] only includes positively-required fields', () => {
  const { schema } = buildValidator({
    all_of: true,
    templates: [
      { kind: 'require_pattern', field: 'url', pattern: '^https://' }, // required
      { kind: 'forbid_pattern',  field: 'sql', pattern: 'DROP' },      // optional
      { kind: 'max_length',      field: 'note', max: 100 },            // optional
    ],
  })
  assert.deepEqual(schema.required, ['url'])
})

test('composite with zero required fields omits required key entirely', () => {
  const { schema } = buildValidator({
    all_of: true,
    templates: [
      { kind: 'forbid_argument', field: 'cmd' },
      { kind: 'max_length',      field: 'note', max: 100 },
    ],
  })
  assert.equal('required' in schema, false)
})

// ── 4. Schemas always have additionalProperties: true ────────────────

test('compiled schemas allow additional properties (gateway args carry extras)', () => {
  const { schema } = buildValidator({ kind: 'enum_values', field: 'method', allowed: ['GET'] })
  assert.equal(schema.additionalProperties, true)
  const v = ajv.compile(schema)
  assert.equal(v({ method: 'GET', tracing_id: 'abc' }), true)
})

// ── 5. Describer helpers (used in cockpit BundlePreview) ─────────────

test('describeTemplate produces plain English for all 6 kinds', () => {
  const cases = [
    [{ kind: 'forbid_argument', field: 'cmd' },              /Forbid any value for argument/],
    [{ kind: 'require_pattern', field: 'u', pattern: '^x' }, /must match pattern/],
    [{ kind: 'forbid_pattern',  field: 's', pattern: 'X' },  /must NOT match pattern/],
    [{ kind: 'max_length',      field: 'n', max: 10 },       /≤ 10 chars/],
    [{ kind: 'enum_values',     field: 'm', allowed: ['GET'] }, /must be one of/],
    [{ kind: 'require_https',   field: 'u' },                /HTTPS URL/],
  ]
  for (const [t, re] of cases) assert.match(describeTemplate(t), re)
})

test('describeComposite joins with AND / OR', () => {
  const c = {
    all_of: true,
    templates: [
      { kind: 'forbid_argument', field: 'a' },
      { kind: 'max_length',      field: 'b', max: 5 },
    ],
  }
  assert.match(describeComposite(c), / AND /)
  assert.match(describeComposite({ ...c, all_of: false }), / OR /)
})

test('describePolicy dispatches to template / composite / legacy', () => {
  const single = {
    id: 'p1', name: 'P1', risk_level: 'LOW',
    template: { kind: 'forbid_argument', field: 'x' },
  }
  const comp = {
    id: 'p2', name: 'P2', risk_level: 'MEDIUM',
    composite: { all_of: true, templates: [{ kind: 'require_https', field: 'u' }] },
  }
  const legacy = { id: 'p3', name: 'P3', risk_level: 'LOW' }
  assert.match(describePolicy(single), /Forbid/)
  assert.match(describePolicy(comp),   /HTTPS/)
  assert.match(describePolicy(legacy), /legacy/)
})

// ── 6. Compiler is deterministic (same input → same output bytes) ─────

test('compileTemplate is deterministic for stable input', () => {
  const t = { kind: 'enum_values', field: 'method', allowed: ['GET', 'HEAD'] }
  const a = JSON.stringify(compileTemplate(t))
  const b = JSON.stringify(compileTemplate(t))
  assert.equal(a, b)
})
