/**
 * Tenant-level runtime configuration.
 *
 * Stored as a JSON blob in organizations.settings (TEXT column).
 * Owned by TenantConfigService (gateway-mcp); also imported by the
 * Cockpit and SDKs for shared typing.
 */

import { z } from 'zod';
import { PolicyDslSchema } from './policy-dsl';

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
