/**
 * Tenant-level runtime configuration.
 *
 * Stored as a JSON blob in organizations.settings (TEXT column).
 * Owned by TenantConfigService (gateway-mcp); also imported by the
 * Cockpit and SDKs for shared typing.
 */

import { z } from 'zod';
import { PolicyDslSchema } from './policy-dsl';
import { SinkConfigSchema } from './sink';
import { CustomDetectorSpecSchema } from './custom-detector';
import { CustomComplianceFrameworkSchema } from './custom-compliance';

export const DeploymentModeSchema = z.enum([
  'dev',
  'standard',
  'strict',
  'financial',
  'healthcare',
  'custom',
]);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const DecisionSchema = z.enum(['allow', 'pending', 'block']);
export type Decision = z.infer<typeof DecisionSchema>;

export const CategoryRiskLevelSchema = z.enum([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

export const LayerConfigSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().min(0).max(1).optional(),
});
export type LayerConfig = z.infer<typeof LayerConfigSchema>;

export const CategoryOverrideSchema = z.object({
  enabled: z.boolean().default(true),
  riskLevel: CategoryRiskLevelSchema.optional(),
  decision: DecisionSchema.optional(),
});
export type CategoryOverride = z.infer<typeof CategoryOverrideSchema>;

export const TenantConfigSchema = z.object({
  version: z.number().int().min(1).default(1),
  deploymentMode: DeploymentModeSchema.default('standard'),
  layers: z.object({
    l1: LayerConfigSchema,
    l2: LayerConfigSchema,
    l3: LayerConfigSchema,
  }),
  thresholds: z.object({
    anomalyScore: z.number().min(0).max(1).default(0.8),
    pendingTimeoutSec: z.number().int().positive().default(300),
  }),
  retention: z.object({
    days: z.number().int().min(1).default(90),
    enforcePII: z.boolean().default(false),
  }),
  policyOverrides: z
    .record(z.string(), CategoryOverrideSchema)
    .default({}),
  dsl: PolicyDslSchema.optional(),
  /**
   * Per-tenant universal sinks — every audit / decision / signal /
   * evidence-pack event AEGIS produces is fanned out to these. One AEGIS
   * deployment can ship to Splunk + Datadog + a custom HTTP receiver
   * simultaneously without forking us. Schema is the discriminated union
   * over http / syslog / stdout sink kinds.
   */
  sinks: z.array(SinkConfigSchema).max(20).default([]),
  /**
   * Cost-burn guardrails. Turns the (already-tracked) per-call token cost
   * from a backward-looking report into a forward-looking budget gate.
   * At evaluation time the BudgetDetector queries spend over the relevant
   * window, compares against limit, and emits warn / critical signals
   * that the decision merger treats like any other security signal.
   *
   * Limits are USD. Any subset of the four scopes may be set. Action:
   *   log    just record a signal (info-level)
   *   warn   emit warn signal (decision still allows)
   *   block  emit critical signal (decision merger blocks)
   * warnAt is the fraction of the limit at which we start emitting warn
   * regardless of action (gives downstream alerting a heads-up).
   */
  budget: z.object({
    enabled: z.boolean().default(false),
    dailyUsd: z.number().min(0).optional(),
    monthlyUsd: z.number().min(0).optional(),
    perAgentDailyUsd: z.number().min(0).optional(),
    perSessionUsd: z.number().min(0).optional(),
    warnAt: z.number().min(0).max(1).default(0.8),
    action: z.enum(['log', 'warn', 'block']).default('warn'),
  }).optional(),
  /**
   * Observability export — surfaces AEGIS traces in the customer's own
   * observability stack (Datadog, Honeycomb, Grafana Tempo, New Relic,
   * any OTLP-compatible backend) rather than locking insight inside the
   * AEGIS dashboard. Wire format: OTLP/HTTP JSON.
   */
  /**
   * Operator-declared detectors. Each spec compiles to a live Detector
   * instance scoped to this tenant — emits signals only when ctx.tenant.id
   * matches this org. Hot-reloaded on tenant_config update.
   * The whole array replaces in-place on PUT (not deep-merged) — same
   * semantic as `dsl.rules` and `sinks`.
   */
  customDetectors: z.array(CustomDetectorSpecSchema).max(50).default([]),
  /**
   * Operator-registered compliance frameworks. The bundle generator
   * picks them up automatically — a customer's PCI-DSS / HIPAA / FFIEC
   * framework registration becomes available at
   * `POST /api/v1/compliance/bundle/<id>` the moment it lands.
   * Reserved IDs (`soc2|iso27001|nist-ai-rmf|eu-ai-act`) are rejected
   * at the API layer to avoid shadowing built-ins.
   */
  customComplianceFrameworks: z.array(CustomComplianceFrameworkSchema).max(20).default([]),
  observability: z.object({
    otlp: z.object({
      enabled: z.boolean().default(false),
      /** Full OTLP traces endpoint (e.g. https://otlp.honeycomb.io/v1/traces).
       *  Path is preserved verbatim — customers point at their backend's
       *  documented v1/traces URL. */
      endpoint: z.string().url(),
      headers: z.record(z.string()).default({}),
      /** Polling interval in seconds; default 30s. */
      intervalSec: z.number().int().min(5).max(3600).default(30),
      /** Max spans per export batch; default 200. */
      batchSize: z.number().int().min(1).max(2000).default(200),
      /** service.name to set on the resource; default 'aegis-gateway'. */
      serviceName: z.string().default('aegis-gateway'),
    }).optional(),
  }).optional(),
  sla: z
    .object({
      targetP50Ms: z.number().int().positive().default(50),
      targetP95Ms: z.number().int().positive().default(200),
    })
    .optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type TenantConfig = z.infer<typeof TenantConfigSchema>;

export const TenantConfigPartialSchema = TenantConfigSchema.deepPartial();
export type TenantConfigPartial = z.infer<typeof TenantConfigPartialSchema>;

export const ApplyTemplateRequestSchema = z.object({
  /** Built-in or operator-registered template id. Registry validates. */
  template: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9.\-_]*$/),
});
export type ApplyTemplateRequest = z.infer<typeof ApplyTemplateRequestSchema>;
