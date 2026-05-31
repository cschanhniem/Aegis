/**
 * Custom compliance framework spec.
 *
 * The operator drops in PCI-DSS, HIPAA, FFIEC, NYDFS 23 NYCRR 500, FedRAMP,
 * client-specific contractual control sets — anything — as JSON. The
 * existing bundle generator picks them up automatically. Once a custom
 * framework is registered, `POST /api/v1/compliance/bundle/<framework_id>`
 * returns a signed, transparency-logged bundle for it just like the
 * built-in 4.
 */

import { z } from 'zod';

export const CustomControlEvidenceSpecSchema = z.object({
  auditActions: z.array(z.string().min(1).max(80)).max(40).optional(),
  detectors: z.array(z.string().min(1).max(120)).max(40).optional(),
  ontology: z.array(z.string().regex(/^(AAT-T\d+|TENANT\.[A-Z0-9_-]+)$/)).max(40).optional(),
  artifacts: z.array(z.enum(['transparency-root', 'audit-row-count', 'evidence-pack-hash'])).max(8).optional(),
}).strict();

export const CustomComplianceControlSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[A-Z][A-Za-z0-9.\-_]*$/),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  evidenceSpec: CustomControlEvidenceSpecSchema,
}).strict();
export type CustomComplianceControlInput = z.input<typeof CustomComplianceControlSchema>;
export type CustomComplianceControl = z.infer<typeof CustomComplianceControlSchema>;

export const CustomComplianceFrameworkSchema = z.object({
  /** Framework id — used in /api/v1/compliance/bundle/:id. Must not
   *  collide with the built-in `soc2|iso27001|nist-ai-rmf|eu-ai-act`. */
  id: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9.\-_]*$/),
  name: z.string().min(1).max(120),
  /** Optional citation pointing at the canonical framework document. */
  reference: z.string().max(500).optional(),
  description: z.string().max(500).optional(),
  controls: z.array(CustomComplianceControlSchema).min(1).max(200),
}).strict();
export type CustomComplianceFrameworkInput = z.input<typeof CustomComplianceFrameworkSchema>;
export type CustomComplianceFramework = z.infer<typeof CustomComplianceFrameworkSchema>;

/** ID set built-in frameworks reserve — operators may not shadow these. */
export const RESERVED_FRAMEWORK_IDS: ReadonlyArray<string> = [
  'soc2', 'iso27001', 'nist-ai-rmf', 'eu-ai-act',
];
