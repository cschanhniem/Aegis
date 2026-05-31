/**
 * Tenant-scoped ontology extension.
 *
 * The AEGIS Agent Threat Ontology v1 is frozen at the gateway level —
 * append-only AAT-T* nodes maintained by the project. Customers regularly
 * have proprietary threats that don't map cleanly (internal codenames,
 * regulator-specific risks, vendor-specific tool families). Rather than
 * forcing those into AAT-T* (which would dilute the canonical taxonomy)
 * or refusing to surface them on the coverage map (which makes the
 * customer's specialized detector look invisible), the tenant can
 * register nodes in the TENANT.* namespace.
 *
 * Stored per-tenant in tenant_config.ontologyNodes[]. Visible only on
 * that tenant's coverage map. Referenced by the same `ontology[]` fields
 * on custom detectors and custom compliance controls.
 */

import { z } from 'zod';

export const TenantOntologyNodeSchema = z.object({
  /** Must start with TENANT. — the AEGIS-published canonical namespace. */
  id: z.string().regex(/^TENANT\.[A-Z0-9_-]+$/),
  /** Tactic grouping for the coverage map. Free-form string so a tenant
   *  can mint a custom tactic (e.g., "regulator-specific") or reuse one
   *  of the 10 canonical AEGIS tactics by slug. */
  tactic: z.string().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  mitigations: z.array(z.string().max(200)).max(10).default([]),
  references: z.array(z.string().max(300)).max(10).default([]),
}).strict();
export type TenantOntologyNode = z.infer<typeof TenantOntologyNodeSchema>;
export type TenantOntologyNodeInput = z.input<typeof TenantOntologyNodeSchema>;
