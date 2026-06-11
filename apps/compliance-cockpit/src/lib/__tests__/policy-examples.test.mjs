/**
 * Tests for the few-shot exemplar bank + the lexical retrieval helper.
 * Doubles as an end-to-end test that every example we ship in the
 * bank IS itself a valid bundle (so the model sees only correct
 * exemplars, not "do as I say not as I do").
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { pickExemplars, FEW_SHOT_EXAMPLES } = await import('../policy-examples.ts')
const { validateBundle } = await import('../policy-validator.ts')

test('every shipped exemplar is itself a valid bundle (no FN/FP in self-tests)', () => {
  for (const ex of FEW_SHOT_EXAMPLES) {
    const bundle = JSON.parse(ex.output)
    const r = validateBundle(bundle)
    assert.ok(r.ok, `exemplar for "${ex.description.slice(0, 40)}…" is itself invalid: ${r.issues.slice(0,3).join(' | ')}`)
    assert.equal(r.score, 1)
  }
})

test('every shipped exemplar carries a non-empty reasoning field (reasoning-first pattern)', () => {
  for (const ex of FEW_SHOT_EXAMPLES) {
    const bundle = JSON.parse(ex.output)
    assert.equal(typeof bundle.reasoning, 'string', `exemplar "${ex.description.slice(0,40)}…" missing reasoning`)
    assert.ok(bundle.reasoning.length > 30, `exemplar reasoning too short`)
    // reasoning MUST be the first key in the JSON shape (the model needs to see this order)
    const firstKey = Object.keys(bundle)[0]
    assert.equal(firstKey, 'reasoning', `exemplar must put reasoning first; got ${firstKey}`)
  }
})

test('pickExemplars prefers the lexically-closest example', () => {
  // Description (a) mentions homelab + Telegram + notes + localhost
  const homelab = pickExemplars('My homelab bot reads Telegram and writes my notes folder', 1)
  assert.equal(homelab.length, 1)
  assert.ok(homelab[0].description.includes('Telegram'))

  // Description (b) mentions Salesforce, sales, emails — should match (b)
  const crm = pickExemplars('A Salesforce sales copilot drafting customer emails', 1)
  assert.equal(crm.length, 1)
  assert.ok(/Salesforce|sales|email/i.test(crm[0].description))
})

test('pickExemplars(k=0) returns empty array', () => {
  const r = pickExemplars('anything', 0)
  assert.deepEqual(r, [])
})

test('pickExemplars handles fully-disjoint description', () => {
  // No overlap → returns the top-K by score (zero here), still K items
  const r = pickExemplars('quark gluon plasma', 2)
  assert.equal(r.length, 2)
})
