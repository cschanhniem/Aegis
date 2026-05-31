/**
 * Custom deployment template spec.
 *
 * Operator declares a template once at the gateway level — every tenant
 * can then `POST /api/v1/config/apply-template { template: <id> }` to
 * snap to that shape. Templates are full TenantConfig snapshots so a
 * customer can bundle "strict layers + Splunk sink + PCI-DSS framework
 * + per-agent budget + DSL for financial workflows" into a single
 * named template (e.g., "bank-prod-2026") and roll it out across N
 * tenants with one API call each.
 *
 * Templates live at gateway scope (not tenant scope) because they
 * represent reusable deployment shapes shared across the operator's
 * tenant fleet. Per-tenant overrides land on top via the normal
 * /config PATCH path.
 */

import { z } from 'zod';
import { TenantConfigSchema } from './tenant-config';

/** IDs reserved for built-in templates — POST /templates rejects these. */
export const RESERVED_TEMPLATE_IDS: ReadonlyArray<string> = [
  'dev', 'standard', 'strict', 'financial', 'healthcare', 'custom',
];

export const CustomTemplateSpecSchema = z.object({
  /** Lower-kebab-case id used in /apply-template { template: <id> }. */
  id: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9.\-_]*$/),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** The applied config. Must validate against TenantConfigSchema. */
  config: TenantConfigSchema,
}).strict();
export type CustomTemplateInput = z.input<typeof CustomTemplateSpecSchema>;
export type CustomTemplateSpec = z.infer<typeof CustomTemplateSpecSchema>;
