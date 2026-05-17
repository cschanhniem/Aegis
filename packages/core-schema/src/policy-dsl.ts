/**
 * Per-tenant Policy DSL document.
 *
 * Stored under tenant_config.dsl. Each tenant has at most one DSL document
 * with up to 100 rules. The DSL is fail-safe: rules can tighten decisions
 * (allow -> pending/block) but never relax an AJV/anomaly block to allow.
 */

import { z } from 'zod';

export const DslDecisionSchema = z.enum(['allow', 'pending', 'block']);
export type DslDecision = z.infer<typeof DslDecisionSchema>;

const PrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const ComparatorSchema = z.union([
  // Bare primitive = equality shorthand
  PrimitiveSchema,
  z.object({ '==': PrimitiveSchema }).strict(),
  z.object({ '!=': PrimitiveSchema }).strict(),
  z.object({ '>': z.number() }).strict(),
  z.object({ '<': z.number() }).strict(),
  z.object({ '>=': z.number() }).strict(),
  z.object({ '<=': z.number() }).strict(),
  z.object({ in: z.array(PrimitiveSchema) }).strict(),
  z.object({ matches: z.string().max(500) }).strict(),
]);
export type Comparator = z.infer<typeof ComparatorSchema>;

// Conditions are recursive: all / any / not / { fieldPath: comparator, ... }
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | Record<string, Comparator>;

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1).max(32) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1).max(32) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z.record(z.string().min(1).max(80), ComparatorSchema),
  ]),
);

export const RuleThenSchema = z.object({
  decision: DslDecisionSchema,
  reason: z.string().max(280).optional(),
  tags: z.array(z.string().max(40)).max(16).optional(),
});
export type RuleThen = z.infer<typeof RuleThenSchema>;

export const RuleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/, 'rule name must be slug-like'),
  when: ConditionSchema.optional(),
  then: RuleThenSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

export const PolicyDslSchema = z.object({
  version: z.literal(1),
  rules: z.array(RuleSchema).max(100),
});
export type PolicyDsl = z.infer<typeof PolicyDslSchema>;
