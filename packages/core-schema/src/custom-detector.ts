/**
 * Custom detector declarative spec.
 *
 * The operator writes (or PUTs over REST) a JSON document and the gateway
 * turns it into a live Detector instance — no code change, no restart,
 * hot-reloaded on tenant_config update.
 *
 * Scope of the declarative language: regex matching against tool name,
 * tool args (as flattened strings), and specific arg paths. Compose with
 * `all` / `any` / `not`. This covers ~80% of vertical-specific detection
 * needs (medical record numbers, internal product codenames, customer-
 * specific token shapes, framework-specific tool name conventions).
 * Anything beyond regex composition → ship a real Detector implementation
 * via the contract in `./detector.ts`.
 *
 * Safety properties:
 *   • No code execution — only declarative AST evaluation.
 *   • Per-detector evaluate timeout enforced by the registry.
 *   • Regex sources are validated and have implicit length bounds.
 *   • Per-tenant — a custom detector emits signals ONLY when ctx.tenant.id
 *     matches the org_id that registered it.
 */

import { z } from 'zod';
import { SeveritySchema, DetectorKindSchema } from './detector';

// Anchor regexes to length to make detector-side ReDoS less likely. We
// REQUIRE the operator's regex be ≤ 512 chars; the runtime additionally
// runs each match with a wall-clock budget.
const REGEX_SOURCE = z.string().min(1).max(512);

// ── Match clauses ────────────────────────────────────────────────────────

export const ToolNameMatchSchema = z.object({
  tool_name_pattern: REGEX_SOURCE,
}).strict();

export const ArgStringMatchSchema = z.object({
  /** Test this regex against EVERY flattened string value in tool.args. */
  arg_string_pattern: REGEX_SOURCE,
}).strict();

export const ArgPathMatchSchema = z.object({
  /** Dotted path into the tool args, e.g. "body.recipient.email". */
  arg_path: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.\-]+$/),
  /** Regex tested against the value at that path (coerced to string). */
  arg_path_pattern: REGEX_SOURCE,
}).strict();

export const AtomicMatchSchema = z.union([
  ToolNameMatchSchema,
  ArgStringMatchSchema,
  ArgPathMatchSchema,
]);
export type AtomicMatch = z.infer<typeof AtomicMatchSchema>;

export const MatchConditionSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(MatchConditionSchema).min(1).max(16) }).strict(),
    z.object({ any: z.array(MatchConditionSchema).min(1).max(16) }).strict(),
    z.object({ not: MatchConditionSchema }).strict(),
    AtomicMatchSchema,
  ])
);
export type MatchCondition = z.infer<typeof MatchConditionSchema>;

// ── Rule + emit ──────────────────────────────────────────────────────────

export const CustomDetectorRuleSchema = z.object({
  /** The trigger. Omitting `when` means "always emit on every call" —
   *  useful as a smoke-test detector while wiring; reject in production
   *  by enabling=false. */
  when: MatchConditionSchema.optional(),
  emit: z.object({
    severity: SeveritySchema,
    category: z.string().min(1).max(120),
    message: z.string().min(1).max(280),
    /** Optional ontology node IDs this rule covers. AEGIS validates that
     *  IDs are either canonical AAT-T* nodes OR start with the tenant
     *  namespace `TENANT.` so customer-defined nodes don't collide. */
    ontology: z.array(z.string().regex(/^(AAT-T\d+|TENANT\.[A-Z0-9_-]+)$/)).max(8).optional(),
  }).strict(),
}).strict();
export type CustomDetectorRule = z.infer<typeof CustomDetectorRuleSchema>;

export const CustomDetectorSpecSchema = z.object({
  /** Unique within the tenant. Becomes part of the registered detector
   *  name as `tenant.<orgId>.<name>` so per-tenant detectors never
   *  collide across tenants. */
  name: z.string().min(1).max(60).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  version: z.string().min(1).max(20).default('1.0.0'),
  kind: DetectorKindSchema.default('content'),
  /** Convenience: top-level coverage claim for the detector. Rule-level
   *  ontology IDs are added on top. */
  coverage: z.array(z.string().regex(/^(AAT-T\d+|TENANT\.[A-Z0-9_-]+)$/)).max(16).default([]),
  description: z.string().max(280).optional(),
  enabled: z.boolean().default(true),
  rules: z.array(CustomDetectorRuleSchema).min(1).max(50),
}).strict();
export type CustomDetectorSpec = z.infer<typeof CustomDetectorSpecSchema>;
export type CustomDetectorInput = z.input<typeof CustomDetectorSpecSchema>;
