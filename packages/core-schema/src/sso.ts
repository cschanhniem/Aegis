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
  /** Generic SAML 2.0 IdP. Pairs with the `saml` config block below.
   *  Used for ADFS, Azure AD SAML, Okta SAML, OneLogin SAML, PingFederate,
   *  Shibboleth — anything that speaks the SAML 2.0 web-browser SSO profile. */
  'saml',
]);
export type SsoProvider = z.infer<typeof SsoProviderSchema>;

/** SAML-specific config. Required when `provider === 'saml'`. */
export const SamlConfigSchema = z.object({
  /** IdP-side entity ID — the value the IdP puts in the SAMLResponse's
   *  <Issuer>. Must match exactly. */
  idp_entity_id: z.string().min(1).max(500),
  /** Where the gateway redirects the browser to start the SSO flow. */
  idp_sso_url: z.string().url(),
  /** IdP's PEM-encoded X.509 signing certificate. Used to verify the
   *  <Signature> inside SAMLResponse. NOT the encryption certificate. */
  idp_certificate_pem: z.string().min(40).max(20_000),
  /** Our (SP) entity ID. Defaults to "agentguard". Many IdPs require a
   *  unique value per integration so customers will override. */
  sp_entity_id: z.string().min(1).max(500).optional(),
  /** Assertion Consumer Service URL — the gateway endpoint the IdP posts
   *  SAMLResponse to. Default: `<gateway>/api/v1/auth/saml/callback`. */
  sp_acs_url: z.string().url().optional(),
  /** When true, the SP signs the AuthnRequest. Required by some IdPs
   *  (Azure AD SAML if "request signing" is enabled). The SP private
   *  key + cert below are then mandatory. */
  sign_authn_request: z.boolean().default(false),
  sp_private_key_pem: z.string().min(40).max(20_000).optional(),
  sp_certificate_pem: z.string().min(40).max(20_000).optional(),
  /** NameID format the SP requests. Most enterprise setups use
   *  "emailAddress"; transient is for short-lived sessions only. */
  name_id_format: z.enum([
    'emailAddress',
    'persistent',
    'transient',
    'unspecified',
  ]).default('emailAddress'),
  /** Attribute path inside <AttributeStatement> that carries the groups
   *  list (used for role mapping). IdP-specific: Okta uses "groups",
   *  Azure AD uses "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups". */
  groups_attribute: z.string().min(1).max(500).optional(),
}).strict();
export type SamlConfig = z.infer<typeof SamlConfigSchema>;

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
  /** SAML-specific config; required when `provider === 'saml'`. */
  saml: SamlConfigSchema.optional(),
}).strict();
export type SsoConfig = z.infer<typeof SsoConfigSchema>;
export type SsoConfigInput = z.input<typeof SsoConfigSchema>;
