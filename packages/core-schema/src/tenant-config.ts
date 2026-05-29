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
  template: DeploymentModeSchema.exclude(['custom']),
});
export type ApplyTemplateRequest = z.infer<typeof ApplyTemplateRequestSchema>;
