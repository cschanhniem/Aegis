/**
 * Policy Templates — a *grammar* for the policies AEGIS will generate.
 *
 * Why this exists: LLM-free-form JSON Schema generation is fragile.
 * The model invents fields, mismatches `not` semantics, forgets
 * `additionalProperties`. Validator-in-loop catches most but not all.
 *
 * The fix that the frontier has converged on (JSONSchemaBench ICLR
 * 2026, llguidance, OpenAI Structured Outputs): constrain the model
 * to a **discriminated union of known-safe templates**. The LLM picks
 * one template per policy and fills its parameters. AEGIS COMPILES
 * the template to the AJV JSON Schema at save time.
 *
 * Guarantees:
 *   - Every generated policy is a valid JSON Schema (compiler is
 *     deterministic + tested).
 *   - Every generated policy uses only AJV constructs we trust.
 *   - The grammar is small enough (6 templates) to enumerate in the
 *     OpenAI strict-mode schema, getting token-level decoding
 *     guarantees.
 *
 * The OUTPUT of compilation is the same AJV JSON Schema the existing
 * gateway / cockpit consume — so the runtime path is unchanged.
 * Templates are an UPSTREAM grammar, not a replacement enforcement.
 */

import { z } from 'zod'

// ── Template discriminated union ──────────────────────────────────────

const FieldName = z.string().min(1).max(80).regex(/^[A-Za-z_][\w.-]{0,79}$/, 'field must be a valid identifier')

/** "Tool argument X is forbidden entirely (any value rejected)."
 *  Implemented by requiring length 0 — every real value fails. */
const ForbidArgumentSchema = z.object({
  kind: z.literal('forbid_argument'),
  field: FieldName,
  reason: z.string().max(200).optional(),
}).strict()

/** Argument must MATCH the given regex (allowlist).
 *  Example: { kind: 'require_pattern', field: 'url', pattern: '^https://api\\.example\\.com/' } */
const RequirePatternSchema = z.object({
  kind: z.literal('require_pattern'),
  field: FieldName,
  pattern: z.string().min(1).max(500),
  reason: z.string().max(200).optional(),
}).strict()

/** Argument must NOT match the given regex (denylist).
 *  Example: { kind: 'forbid_pattern', field: 'sql', pattern: 'DROP\\s+TABLE' } */
const ForbidPatternSchema = z.object({
  kind: z.literal('forbid_pattern'),
  field: FieldName,
  pattern: z.string().min(1).max(500),
  reason: z.string().max(200).optional(),
}).strict()

/** Argument must be at most N characters. */
const MaxLengthSchema = z.object({
  kind: z.literal('max_length'),
  field: FieldName,
  max: z.number().int().nonnegative().max(1_000_000),
  reason: z.string().max(200).optional(),
}).strict()

/** Argument must be one of a fixed set of values.
 *  Example: { kind: 'enum_values', field: 'method', allowed: ['GET', 'HEAD'] } */
const EnumValuesSchema = z.object({
  kind: z.literal('enum_values'),
  field: FieldName,
  allowed: z.array(z.union([z.string().max(200), z.number(), z.boolean()])).min(1).max(50),
  reason: z.string().max(200).optional(),
}).strict()

/** Argument must be an HTTPS URL. Convenience shortcut for the very
 *  common "outbound calls must be encrypted" rule. */
const RequireHttpsSchema = z.object({
  kind: z.literal('require_https'),
  field: FieldName,
  reason: z.string().max(200).optional(),
}).strict()

export const PolicyTemplateSchema = z.discriminatedUnion('kind', [
  ForbidArgumentSchema,
  RequirePatternSchema,
  ForbidPatternSchema,
  MaxLengthSchema,
  EnumValuesSchema,
  RequireHttpsSchema,
])
export type PolicyTemplate = z.infer<typeof PolicyTemplateSchema>

/** A *composite* template: multiple sub-templates ANDed together.
 *  Lets a single policy express "args.url must be HTTPS AND args.method
 *  must be GET" without inventing a separate template per combination. */
export const CompositeTemplateSchema = z.object({
  /** When true, ALL sub-templates must pass (default). When false, ANY. */
  all_of: z.boolean().default(true),
  templates: z.array(PolicyTemplateSchema).min(1).max(8),
}).strict()
export type CompositeTemplate = z.infer<typeof CompositeTemplateSchema>

/** A policy in template form. Either a single template (`template`) OR
 *  a composite (`composite`). The model emits ONE of the two; we
 *  validate via the same discriminated approach. */
export const TemplatePolicySchema = z.object({
  id: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  template: PolicyTemplateSchema.optional(),
  composite: CompositeTemplateSchema.optional(),
}).strict()
export type TemplatePolicy = z.infer<typeof TemplatePolicySchema>

// ── Template → AJV JSON Schema compiler ───────────────────────────────

/** Compile a single template into a valid AJV JSON Schema fragment
 *  applied to a single property of the tool's arguments. */
function compileSingle(t: PolicyTemplate): Record<string, unknown> {
  switch (t.kind) {
    case 'forbid_argument':
      // Allow the field to exist but constrain it to length 0 / value
      // that can never match anything reasonable.
      return { type: ['string', 'number', 'boolean', 'object', 'array', 'null'], maxLength: 0 }
    case 'require_pattern':
      return { type: 'string', pattern: t.pattern }
    case 'forbid_pattern':
      return { type: 'string', not: { pattern: t.pattern } }
    case 'max_length':
      return { type: 'string', maxLength: t.max }
    case 'enum_values':
      return { enum: t.allowed }
    case 'require_https':
      return { type: 'string', pattern: '^https://' }
  }
}

/** Compile a template (or composite) into the full AJV JSON Schema
 *  the gateway applies to a tool call's `arguments` object. */
export function compileTemplate(input: PolicyTemplate | CompositeTemplate): Record<string, unknown> {
  if ('templates' in input) {
    // Composite — group by field so multiple constraints on the same
    // arg fold into one combined sub-schema.
    const byField = new Map<string, Array<Record<string, unknown>>>()
    for (const t of input.templates) {
      const k = t.field
      if (!byField.has(k)) byField.set(k, [])
      byField.get(k)!.push(compileSingle(t))
    }
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [field, schemas] of Array.from(byField.entries())) {
      properties[field] = schemas.length === 1
        ? schemas[0]
        : (input.all_of ? { allOf: schemas } : { anyOf: schemas })
      // For required-pattern / require-https / enum-values, the field
      // must exist; for forbid/max_length we leave it optional.
      const kinds = input.templates.filter(t => t.field === field).map(t => t.kind)
      if (kinds.some(k => k === 'require_pattern' || k === 'require_https' || k === 'enum_values')) {
        required.push(field)
      }
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: true,
    }
  }

  // Single template
  const fieldSchema = compileSingle(input)
  const requireField = input.kind === 'require_pattern' || input.kind === 'require_https' || input.kind === 'enum_values'
  return {
    type: 'object',
    properties: { [input.field]: fieldSchema },
    ...(requireField ? { required: [input.field] } : {}),
    additionalProperties: true,
  }
}

// ── Human description (for cockpit rendering) ────────────────────────

/** Plain-English summary of a single template. Used in BundlePreview. */
export function describeTemplate(t: PolicyTemplate): string {
  switch (t.kind) {
    case 'forbid_argument':  return `Forbid any value for argument \`${t.field}\``
    case 'require_pattern':  return `Argument \`${t.field}\` must match pattern \`${t.pattern}\``
    case 'forbid_pattern':   return `Argument \`${t.field}\` must NOT match pattern \`${t.pattern}\``
    case 'max_length':       return `Argument \`${t.field}\` must be ≤ ${t.max} chars`
    case 'enum_values':      return `Argument \`${t.field}\` must be one of: ${t.allowed.map(v => JSON.stringify(v)).join(', ')}`
    case 'require_https':    return `Argument \`${t.field}\` must be an HTTPS URL`
  }
}

/** Composite description — joins sub-templates with AND / OR. */
export function describeComposite(c: CompositeTemplate): string {
  const parts = c.templates.map(describeTemplate)
  const sep = c.all_of ? ' AND ' : ' OR '
  return parts.join(sep)
}

/** Wraps `TemplatePolicy` → human prose for cockpit rendering. */
export function describePolicy(p: TemplatePolicy): string {
  if (p.template) return describeTemplate(p.template)
  if (p.composite) return describeComposite(p.composite)
  return '(no template — legacy policy_schema)'
}
