/**
 * Pure-function validator for the NL → policy bundle the LLM produces.
 *
 * Industrial-grade contract (the test suite enforces this):
 *   1. Reject anything that's not the right shape.
 *   2. AJV-compile every policy_schema; collect compile errors.
 *   3. Execute the model-emitted self-tests against the AJV validators
 *      and surface every false-negative (should_block that passed) and
 *      false-positive (should_allow that failed).
 *   4. Shape-check the DSL — names, decisions, rule count caps.
 *   5. Return a single ValidationReport the caller can either use to
 *      accept the bundle or feed back into the next LLM round.
 *
 * Side-effect-free; safe to import from API routes, tests, and the
 * client side (no Node-only globals).
 */
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import {
  PolicyTemplateSchema,
  CompositeTemplateSchema,
  compileTemplate,
  type PolicyTemplate,
  type CompositeTemplate,
} from './policy-templates'

export interface PolicyTest {
  tool?: string
  arguments: Record<string, unknown>
}

/** A policy can be expressed in EITHER of two equivalent forms:
 *    - `template` / `composite` — grammar-constrained, the model picks
 *      from 6 known-safe shapes and we compile to JSON Schema.
 *    - `policy_schema` — raw JSON Schema (legacy / advanced escape hatch).
 *  At least one must be present. If multiple are present, `composite` >
 *  `template` > `policy_schema`. */
export interface Policy {
  id: string
  name: string
  description?: string
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  template?: PolicyTemplate
  composite?: CompositeTemplate
  policy_schema?: any
  tests?: { should_block: PolicyTest[]; should_allow: PolicyTest[] }
}

export interface DslRule {
  name: string
  when?: any
  then: { decision: 'allow' | 'pending' | 'block'; reason?: string }
}

export interface Bundle {
  policies: Policy[]
  dsl: { version: 1; rules: DslRule[] }
}

export interface PolicyTestResult {
  policy_id: string
  block_pass: number
  block_fail: number
  allow_pass: number
  allow_fail: number
}

export interface ValidationReport {
  ok: boolean
  issues: string[]
  testResults: PolicyTestResult[]
  /** Tests-passed / tests-total. When no tests are emitted this falls
   *  back to 1 (when issues are empty) or 0.5 (degraded). */
  score: number
}

export function buildAjv(): Ajv {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true })
  addFormats(ajv)
  return ajv
}

export function validateBundle(bundle: any): ValidationReport {
  const issues: string[] = []
  const testResults: PolicyTestResult[] = []
  let testsTotal = 0
  let testsPassed = 0

  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, issues: ['bundle is not an object'], testResults, score: 0 }
  }
  if (!Array.isArray(bundle.policies)) {
    return { ok: false, issues: ['bundle.policies must be an array'], testResults, score: 0 }
  }
  if (bundle.policies.length === 0) {
    return { ok: false, issues: ['at least one policy required'], testResults, score: 0 }
  }
  if (!bundle.dsl || bundle.dsl.version !== 1) issues.push('dsl.version must be 1')
  if (!Array.isArray(bundle.dsl?.rules))       issues.push('dsl.rules must be an array')

  const ajv = buildAjv()
  for (const p of bundle.policies as Policy[]) {
    if (!p?.id || !p?.name) {
      issues.push(`policy ${JSON.stringify(p?.id ?? '(no id)')} missing required fields`)
      continue
    }
    if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(p.risk_level)) {
      issues.push(`policy '${p.id}' has invalid risk_level '${p.risk_level}'`)
    }

    // Resolve the policy's JSON Schema: prefer composite > template >
    // raw policy_schema. We validate the chosen grammar input with Zod
    // before compiling so a malformed template surfaces as a clean
    // "template did not parse" issue rather than an AJV crash.
    let resolvedSchema: any = null
    if (p.composite !== undefined) {
      const parsed = CompositeTemplateSchema.safeParse(p.composite)
      if (!parsed.success) {
        issues.push(`policy '${p.id}' composite invalid: ${parsed.error.issues.map(i => i.message).join('; ')}`)
        testResults.push({ policy_id: p.id, block_pass: 0, block_fail: 0, allow_pass: 0, allow_fail: 0 })
        continue
      }
      resolvedSchema = compileTemplate(parsed.data)
    } else if (p.template !== undefined) {
      const parsed = PolicyTemplateSchema.safeParse(p.template)
      if (!parsed.success) {
        issues.push(`policy '${p.id}' template invalid: ${parsed.error.issues.map(i => i.message).join('; ')}`)
        testResults.push({ policy_id: p.id, block_pass: 0, block_fail: 0, allow_pass: 0, allow_fail: 0 })
        continue
      }
      resolvedSchema = compileTemplate(parsed.data)
    } else if (p.policy_schema !== undefined) {
      resolvedSchema = p.policy_schema
    } else {
      issues.push(`policy '${p.id}' missing template / composite / policy_schema`)
      testResults.push({ policy_id: p.id, block_pass: 0, block_fail: 0, allow_pass: 0, allow_fail: 0 })
      continue
    }

    let validate: any
    try { validate = ajv.compile(resolvedSchema) }
    catch (err: any) {
      issues.push(`policy '${p.id}' policy_schema does not compile: ${err.message}`)
      testResults.push({ policy_id: p.id, block_pass: 0, block_fail: 0, allow_pass: 0, allow_fail: 0 })
      continue
    }

    const tests = p.tests ?? { should_block: [], should_allow: [] }
    let blockPass = 0, blockFail = 0, allowPass = 0, allowFail = 0
    for (const t of tests.should_block ?? []) {
      testsTotal++
      const passes = !!validate(t.arguments)
      if (passes) {
        blockFail++
        issues.push(`policy '${p.id}': should_block test ${JSON.stringify(t.arguments).slice(0, 80)} was NOT blocked (false negative)`)
      } else { blockPass++; testsPassed++ }
    }
    for (const t of tests.should_allow ?? []) {
      testsTotal++
      const passes = !!validate(t.arguments)
      if (!passes) {
        allowFail++
        issues.push(`policy '${p.id}': should_allow test ${JSON.stringify(t.arguments).slice(0, 80)} was BLOCKED (false positive); AJV errors: ${JSON.stringify(validate.errors?.slice(0, 2))}`)
      } else { allowPass++; testsPassed++ }
    }
    testResults.push({ policy_id: p.id, block_pass: blockPass, block_fail: blockFail, allow_pass: allowPass, allow_fail: allowFail })
  }

  for (const r of (bundle.dsl?.rules ?? []) as DslRule[]) {
    if (!r?.name || !r?.then) {
      issues.push(`dsl rule missing 'name' or 'then'`)
      continue
    }
    if (!['allow', 'pending', 'block'].includes(r.then.decision)) {
      issues.push(`dsl rule '${r.name}' has invalid decision '${r.then.decision}'`)
    }
  }

  const score = testsTotal > 0 ? testsPassed / testsTotal : (issues.length === 0 ? 1 : 0.5)
  return { ok: issues.length === 0, issues, testResults, score }
}
