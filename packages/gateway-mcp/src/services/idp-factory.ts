/**
 * IdP adapter factory — picks the right adapter for a tenant's SSO
 * config. Returns the Mock adapter when SSO isn't configured so local
 * dev / fresh deployments keep working.
 *
 * Why a factory and not a registry:
 *   - One tenant has at most one SSO config at a time.
 *   - Adapters are cheap to construct; no need to memoize.
 *   - If a tenant flips between providers, every login picks up the
 *     new adapter on the next call — no restart, no warm-up.
 */

import { Logger } from 'pino';
import { IdpAdapter, MockIdpAdapter } from './idp-adapter';
import { OidcAdapter } from './oidc-adapter';
import { SamlAdapter } from './saml-adapter';
import { TenantConfigService } from './tenant-config';

export class IdpFactory {
  constructor(
    private logger: Logger,
    private tenantConfig: TenantConfigService,
  ) {}

  /** Resolve the IdP adapter for the given tenant. Falls back to Mock
   *  when the tenant has no SSO config or has explicitly disabled it. */
  for(orgId: string): IdpAdapter {
    const sso = this.tenantConfig.get(orgId).sso;
    if (!sso || !sso.enabled || sso.provider === 'mock') {
      return new MockIdpAdapter();
    }
    if (sso.provider === 'workos') {
      // Stub today — see services/idp-adapter.ts. Surface the missing-
      // config as a clear error rather than letting the throw bubble.
      throw new Error('WorkOS adapter is a stub — set provider to okta / azure-ad / google / oidc-generic / saml');
    }
    try {
      if (sso.provider === 'saml') {
        return new SamlAdapter(sso, this.logger);
      }
      return new OidcAdapter(sso, this.logger);
    } catch (err) {
      this.logger.warn(
        { orgId, err: (err as Error).message, provider: sso.provider },
        'SSO adapter construction failed — falling back to Mock for this login',
      );
      return new MockIdpAdapter();
    }
  }
}
