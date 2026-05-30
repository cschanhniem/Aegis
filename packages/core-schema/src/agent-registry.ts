/**
 * Agent registry — first-class agent identity for AEGIS.
 *
 * Before the registry, `agent_id` was a string anyone could pass. After the
 * registry it's a registered, scoped, status-checked identity that every
 * audit row and policy decision attributes against. Three trust levels:
 *
 *   unregistered  first sighting auto-records; AEGIS continues to serve
 *                 (backward compat) but audit rows are tagged 'weak'.
 *   active        operator completed registration; full trust, declared
 *                 tool scope enforced, per-agent budget honored.
 *   suspended     operator pause; AEGIS blocks ALL calls at the gate.
 *   deprecated    soft-deleted; behaves like suspended but excluded from
 *                 default list endpoints.
 */

import { z } from 'zod';

export const AgentStatusSchema = z.enum([
  'unregistered',
  'active',
  'suspended',
  'deprecated',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentEnvironmentSchema = z.enum(['dev', 'staging', 'prod']);
export type AgentEnvironment = z.infer<typeof AgentEnvironmentSchema>;

/** Payload that operators POST to /api/v1/agents to register a new agent.
 *  All optional — the only required identity is the auto-generated UUID. */
export const AgentRegistrationRequestSchema = z.object({
  /** Provide one to register a specific id (e.g. promote an unregistered
   *  agent the SDK has been calling in as). Omit to mint a fresh UUID. */
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  owner_email: z.string().email().optional(),
  declared_tools: z.array(z.string().min(1).max(120)).max(200).optional(),
  max_cost_daily_usd: z.number().min(0).optional(),
  environments: z.array(AgentEnvironmentSchema).max(5).optional(),
  /** Issue an agent secret on registration. Returned ONCE in the
   *  response; only SHA-256 hash is kept server-side. */
  issue_secret: z.boolean().default(false),
  /** Optional pinned Ed25519 public key (PEM) for agent-signed requests. */
  public_key_pem: z.string().optional(),
});
export type AgentRegistrationRequest = z.infer<typeof AgentRegistrationRequestSchema>;
/** Input shape — what callers actually pass (defaults not yet applied). */
export type AgentRegistrationInput = z.input<typeof AgentRegistrationRequestSchema>;

export const AgentUpdateRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  owner_email: z.string().email().optional(),
  declared_tools: z.array(z.string().min(1).max(120)).max(200).optional(),
  max_cost_daily_usd: z.number().min(0).nullable().optional(),
  environments: z.array(AgentEnvironmentSchema).max(5).optional(),
  status: AgentStatusSchema.exclude(['unregistered']).optional(),
  public_key_pem: z.string().nullable().optional(),
});
export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequestSchema>;

/** The public shape of a registered agent. `secret` is only present on
 *  the registration response (and on rotate-secret). */
export interface RegisteredAgent {
  id: string;
  org_id: string;
  name?: string;
  description?: string;
  owner_email?: string;
  declared_tools?: ReadonlyArray<string>;
  max_cost_daily_usd?: number;
  environments?: ReadonlyArray<AgentEnvironment>;
  status: AgentStatus;
  has_secret: boolean;
  has_public_key: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at?: string;
}

export interface AgentRegistrationResponse {
  agent: RegisteredAgent;
  /** Plaintext secret returned ONCE on issue. */
  secret?: string;
}

/** Audit-side attribution strength. Stays loose for unregistered agents so
 *  legacy callers continue to work; tightens to 'strong' once promoted. */
export type AttributionStrength = 'strong' | 'weak' | 'unknown';
