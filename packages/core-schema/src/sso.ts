/**
 * SSO / IdP configuration spec.
 *
 * Stored at tenant scope (each customer brings their own Okta / Azure AD /
 * Google Workspace tenant) so a single AEGIS gateway can authenticate
 * users from many enterprise IdPs at once.
 *
 * `provider` selects a preset that fills in default scopes + claim-mapping
 * heuristics; `issuer` + `client_id` + `client_secret` are always required.
 * For Auth0 / Keycloak / Ping / OneLogin or any other OIDC-compliant
 * provider, set `provider: 'oidc-generic'` and the adapter discovers the
 * endpoints from <issuer>/.well-known/openid-configuration.
 */

import { z } from 'zod';

export const SsoProviderSchema = z.enum([
  'mock',
  'okta',
  'azure-ad',
  'google',
  'oidc-generic',
  'workos',
]);
export type SsoProvider = z.infer<typeof SsoProviderSchema>;

export const SsoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: SsoProviderSchema.default('mock'),
  /** OIDC issuer URL — e.g. `https://acme.okta.com/oauth2/default`,
   *  `https://login.microsoftonline.com/<tenant-id>/v2.0`, or
   *  `https://accounts.google.com`. The adapter probes
   *  <issuer>/.well-known/openid-configuration to find endpoints. */
  issuer: z.string().url().optional(),
  client_id: z.string().min(1).max(200).optional(),
  /** Stored at-rest in tenant config. For higher-security deployments
   *  use a secret-manager reference here and resolve at start (out of
   *  scope for v1). */
  client_secret: z.string().min(1).max(500).optional(),
  /** OIDC scopes. Defaults applied by adapter based on `provider`. */
  scopes: z.array(z.string().min(1).max(60)).max(20).optional(),
  /** If set, only users whose email matches one of these domains may
   *  sign in. Defense in depth — IdP-level controls are the primary. */
  allowed_email_domains: z.array(z.string().min(1).max(120)).max(20).optional(),
  /** Map IdP group / role claim values to AEGIS roles. The IdP group
   *  membership is treated as a hint; final role lives in the local
   *  users table where an admin can override. */
  role_mapping: z.object({
    admin:   z.array(z.string()).max(20).default([]),
    auditor: z.array(z.string()).max(20).default([]),
    viewer:  z.array(z.string()).max(20).default([]),
  }).partial().optional(),
}).strict();
export type SsoConfig = z.infer<typeof SsoConfigSchema>;
export type SsoConfigInput = z.input<typeof SsoConfigSchema>;
