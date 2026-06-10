/**
 * Generic OIDC adapter — handles Okta, Azure AD (Entra), Google
 * Workspace, Auth0, Keycloak, Ping, OneLogin, and any other
 * RFC-compliant OIDC provider.
 *
 * One implementation covers all three because the OIDC dance is
 * uniform — discovery doc + authorize URL + token exchange + userinfo.
 * Provider-specific defaults (scopes, role-claim names) come from the
 * preset map; everything else is wire-format identical.
 *
 * Endpoint resolution:
 *   - When constructed with a `discovery_url` (or computed from issuer),
 *     fetches `${issuer}/.well-known/openid-configuration` lazily on
 *     first redirectUrl / exchangeCode call. Cached for the lifetime
 *     of the instance.
 *   - Customers can pin explicit endpoints to avoid the discovery
 *     fetch (air-gapped deployments). Not in v1 — discovery is good
 *     enough.
 */

import { Logger } from 'pino';
import { IdpAdapter, IdpUser } from './idp-adapter';
import { SsoConfig, SsoProvider } from '@agentguard/core-schema';

interface ProviderPreset {
  readonly defaultScopes: ReadonlyArray<string>;
  /** Claim path that holds the provider-side groups/roles list — used
   *  for role_hint mapping. */
  readonly groupsClaim?: string;
  /** Friendly user-facing name. */
  readonly displayName: string;
  /** Resolved value of `IdpUser.provider`. */
  readonly providerTag: IdpUser['provider'];
}

const PRESETS: Record<Exclude<SsoProvider, 'mock' | 'workos' | 'saml'>, ProviderPreset> = {
  okta: {
    defaultScopes: ['openid', 'profile', 'email', 'groups'],
    groupsClaim: 'groups',
    displayName: 'Okta',
    providerTag: 'okta',
  },
  'azure-ad': {
    // Azure AD requires the V2 endpoint to honor `scope=email`.
    defaultScopes: ['openid', 'profile', 'email', 'User.Read'],
    groupsClaim: 'groups',
    displayName: 'Microsoft Entra ID',
    providerTag: 'azure-ad',
  },
  google: {
    defaultScopes: ['openid', 'profile', 'email'],
    // Google doesn't expose group memberships in userinfo by default;
    // operator must use Workspace API + a custom claim if they want
    // role mapping. Out of scope for v1.
    displayName: 'Google Workspace',
    providerTag: 'google',
  },
  'oidc-generic': {
    defaultScopes: ['openid', 'profile', 'email'],
    groupsClaim: 'groups',
    displayName: 'OIDC',
    providerTag: 'oidc-generic',
  },
};

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri?: string;
  issuer: string;
}

export class OidcAdapter implements IdpAdapter {
  readonly name: string;
  private discovery?: DiscoveryDoc;
  private readonly preset: ProviderPreset;

  constructor(
    private cfg: SsoConfig,
    private logger?: Logger,
  ) {
    if (cfg.provider === 'mock' || cfg.provider === 'workos') {
      throw new Error(`OidcAdapter does not handle provider '${cfg.provider}'`);
    }
    this.preset = PRESETS[cfg.provider as keyof typeof PRESETS];
    this.name = this.preset.providerTag;
    if (!cfg.issuer || !cfg.client_id || !cfg.client_secret) {
      throw new Error('OIDC adapter requires issuer + client_id + client_secret');
    }
  }

  private async discover(): Promise<DiscoveryDoc> {
    if (this.discovery) return this.discovery;
    const url = `${this.cfg.issuer!.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: ${url} → ${res.status}`);
    }
    const doc = await res.json() as DiscoveryDoc;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
      throw new Error(`OIDC discovery doc missing required endpoints (issuer=${this.cfg.issuer})`);
    }
    this.discovery = doc;
    return doc;
  }

  /** Build the authorize URL the Cockpit redirects the browser to.
   *  redirectUrl is sync on the IdpAdapter contract; we return a Promise
   *  in practice would be cleaner, but to keep the contract stable we
   *  cache discovery on first exchangeCode call and synthesize a URL
   *  here from issuer using OIDC's well-known authorize path. Most
   *  providers respect the discovered endpoint, but if a provider uses
   *  a non-standard path the operator can call `prefetch()` once at
   *  start so discovery is cached before login traffic. */
  redirectUrl(opts: { state: string; redirect_uri: string }): string {
    const base = this.discovery?.authorization_endpoint
      ?? `${this.cfg.issuer!.replace(/\/$/, '')}/oauth2/v1/authorize`;
    const scopes = (this.cfg.scopes ?? this.preset.defaultScopes).join(' ');
    const sp = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.client_id!,
      redirect_uri: opts.redirect_uri,
      scope: scopes,
      state: opts.state,
    });
    return `${base}?${sp.toString()}`;
  }

  async exchangeCode(opts: {
    code: string;
    state: string;
    expected_state: string;
    redirect_uri: string;
  }): Promise<IdpUser> {
    if (opts.state !== opts.expected_state) {
      throw new Error('state mismatch');
    }
    const doc = await this.discover();

    // 1. Exchange the code for tokens.
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: opts.code,
        redirect_uri: opts.redirect_uri,
        client_id: this.cfg.client_id!,
        client_secret: this.cfg.client_secret!,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      throw new Error(`OIDC token exchange failed: ${tokenRes.status} ${detail.slice(0, 120)}`);
    }
    const tokens = await tokenRes.json() as { access_token: string; id_token?: string };

    // 2. Fetch userinfo with the access token.
    const userRes = await fetch(doc.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    if (!userRes.ok) {
      throw new Error(`OIDC userinfo failed: ${userRes.status}`);
    }
    const claims = await userRes.json() as Record<string, any>;

    const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
    if (!email) throw new Error('IdP returned no email claim');

    // 3. Domain allow-list enforcement (defense in depth).
    if (this.cfg.allowed_email_domains && this.cfg.allowed_email_domains.length > 0) {
      const domain = email.split('@')[1] ?? '';
      if (!this.cfg.allowed_email_domains.includes(domain)) {
        throw new Error(`email domain '${domain}' is not in the SSO allow list`);
      }
    }

    // 4. Role hint via group-claim → role-mapping. The local users table
    //    has final say; this is just a suggestion the gateway carries
    //    on first sighting of a new user.
    const role_hint = this.deriveRoleHint(claims);

    return {
      sub: String(claims.sub ?? claims.oid ?? email),
      email,
      name: claims.name ?? claims.given_name ?? undefined,
      role_hint,
      provider: this.preset.providerTag,
    };
  }

  private deriveRoleHint(claims: Record<string, any>): IdpUser['role_hint'] | undefined {
    const mapping = this.cfg.role_mapping;
    const claimKey = this.preset.groupsClaim;
    if (!mapping || !claimKey) return undefined;
    const groups = claims[claimKey];
    if (!Array.isArray(groups)) return undefined;
    const set = new Set(groups.map(String));
    if ((mapping.admin   ?? []).some(g => set.has(g))) return 'admin';
    if ((mapping.auditor ?? []).some(g => set.has(g))) return 'auditor';
    if ((mapping.viewer  ?? []).some(g => set.has(g))) return 'viewer';
    return undefined;
  }
}
