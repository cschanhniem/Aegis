/**
 * SAML 2.0 Web Browser SSO Profile adapter.
 *
 * The customer-facing problem: Fortune 500 IT teams overwhelmingly run
 * SAML IdPs (ADFS, Azure AD SAML, Okta SAML, Ping, OneLogin, Shibboleth).
 * Without a SAML adapter we lose every deal that goes through enterprise
 * IT review. OIDC alone reaches ~70% of the market; SAML closes the rest.
 *
 * Implementation: `samlify` handles the protocol primitives (AuthnRequest
 * generation, SAMLResponse parsing, XML signature verification, audience
 * + NotOnOrAfter checks). We use it via the IdpAdapter contract so the
 * gateway treats SAML logins identically to OIDC ones from the call-site
 * perspective.
 *
 * Quirks the adapter takes care of:
 *
 *   1. Binding semantics. SAML SSO arrives via *POST* (assertion in form
 *      body), not the OAuth code redirect OIDC uses. We reuse the
 *      IdpAdapter contract by treating `code` as the base64 SAMLResponse.
 *      The HTTP route layer is responsible for plumbing the form field
 *      into `exchangeCode({code: req.body.SAMLResponse, ...})`.
 *
 *   2. State. SAML doesn't have an OAuth-style `state` param; we ride on
 *      its `RelayState` field for CSRF-equivalent protection.
 *
 *   3. Identity. We prefer the SAML <Subject>/<NameID> when it's an email
 *      (the default config asks the IdP for emailAddress NameID format).
 *      If the IdP refuses, we fall back to the first <Attribute Name="...email">
 *      or sub-style claim.
 *
 *   4. Group mapping. Most IdPs ship the role/group list under a
 *      tenant-configured attribute name; we read it through the adapter's
 *      `role_mapping` field and derive `role_hint` the same way the
 *      OIDC adapter does — so the rest of the gateway doesn't care
 *      whether the human came in via SAML or OIDC.
 */

import { Logger } from 'pino';
import * as samlify from 'samlify';
import * as validator from '@authenio/samlify-node-xmllint';
import { IdpAdapter, IdpUser } from './idp-adapter';
import { SsoConfig } from '@agentguard/core-schema';

// samlify requires an XML schema validator. The Node-bound xmllint
// package is the production-stable choice.
samlify.setSchemaValidator(validator as any);

/** NameID-format URN map. samlify wants the full URN, but our schema
 *  exposes the short form (`emailAddress`) for ergonomics. */
const NAMEID_URN: Record<string, string> = {
  emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent:   'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient:    'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  unspecified:  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
};

export class SamlAdapter implements IdpAdapter {
  readonly name = 'saml';

  private sp: any;
  private idp: any;
  private spEntityId: string;
  private spAcsUrl: string;

  constructor(private config: SsoConfig, private logger: Logger) {
    const s = config.saml;
    if (!s) throw new Error('SAML config missing — set sso.saml.{idp_entity_id, idp_sso_url, idp_certificate_pem}');

    this.spEntityId = s.sp_entity_id ?? 'agentguard';
    this.spAcsUrl   = s.sp_acs_url   ?? 'https://gateway.local/api/v1/auth/saml/callback';

    this.sp = samlify.ServiceProvider({
      entityID: this.spEntityId,
      authnRequestsSigned: !!s.sign_authn_request,
      wantAssertionsSigned: true,
      wantMessageSigned: false,
      nameIDFormat: [NAMEID_URN[s.name_id_format ?? 'emailAddress']],
      assertionConsumerService: [{
        Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
        Location: this.spAcsUrl,
      }],
      ...(s.sign_authn_request && s.sp_private_key_pem ? { privateKey: s.sp_private_key_pem } : {}),
      ...(s.sign_authn_request && s.sp_certificate_pem ? { signingCert: s.sp_certificate_pem } : {}),
    });

    this.idp = samlify.IdentityProvider({
      entityID: s.idp_entity_id,
      isAssertionEncrypted: false,
      singleSignOnService: [{
        Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
        Location: s.idp_sso_url,
      }],
      signingCert: s.idp_certificate_pem,
    });
  }

  /** Build the IdP redirect URL. `state` rides on RelayState — the IdP
   *  reflects it back unchanged in its POST callback, giving us
   *  CSRF-equivalent binding without a separate SAML mechanism. */
  redirectUrl(opts: { state: string; redirect_uri: string }): string {
    const { context } = this.sp.createLoginRequest(this.idp, 'redirect');
    // samlify returns a URL like ".../sso?SAMLRequest=...". Append the
    // RelayState that the IdP must echo back on POST.
    const sep = context.includes('?') ? '&' : '?';
    return `${context}${sep}RelayState=${encodeURIComponent(opts.state)}`;
  }

  /** Process a SAMLResponse. The route handler should pass the raw
   *  POST body's `SAMLResponse` field as `code`, and the `RelayState`
   *  field as `state`. */
  async exchangeCode(opts: {
    code: string; state: string; expected_state: string; redirect_uri: string;
  }): Promise<IdpUser> {
    if (opts.state !== opts.expected_state) {
      throw new Error('RelayState mismatch — possible CSRF');
    }
    const parsed = await this.sp.parseLoginResponse(this.idp, 'post', {
      body: { SAMLResponse: opts.code, RelayState: opts.state },
    });
    const ext = parsed?.extract ?? {};
    const nameID: string = ext.nameID ?? ext.attributes?.NameID ?? '';
    const attrs: Record<string, any> = ext.attributes ?? {};

    // Identity resolution. Prefer NameID when it's an email (the format
    // we requested); else fall back to common attribute names.
    const email: string =
      (typeof nameID === 'string' && nameID.includes('@')) ? nameID :
      (attrs['email'] ?? attrs['mail'] ?? attrs['EmailAddress'] ??
       attrs['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] ?? '');

    if (!email || !email.includes('@')) {
      throw new Error('SAMLResponse did not yield a usable email identity');
    }

    // Group → role mapping. We honour the per-tenant attribute name and
    // the same role_mapping.{admin,auditor,viewer} table the OIDC adapter
    // consults, so downstream code is uniform.
    const groupsAttr = this.config.saml?.groups_attribute;
    const groupsRaw  = groupsAttr ? attrs[groupsAttr] : (attrs['groups'] ?? attrs['Groups']);
    const groups     = Array.isArray(groupsRaw) ? groupsRaw.map(String) : (typeof groupsRaw === 'string' ? [groupsRaw] : []);
    const role_hint  = this.deriveRoleHint(groups);

    // Email-domain allowlist (defense-in-depth on top of IdP-side rules).
    const allowed = this.config.allowed_email_domains;
    if (allowed && allowed.length > 0) {
      const domain = email.split('@')[1] ?? '';
      if (!allowed.includes(domain)) {
        throw new Error(`Email domain not allowed: ${domain}`);
      }
    }

    return {
      sub:       (typeof nameID === 'string' && nameID) || `saml:${email}`,
      email,
      name:      attrs['displayName'] ?? attrs['name'] ?? attrs['givenName'] ?? email.split('@')[0],
      role_hint,
      provider:  'saml',
    };
  }

  /** SP metadata XML for the customer to upload to their IdP. */
  spMetadata(): string {
    return this.sp.getMetadata();
  }

  private deriveRoleHint(groups: string[]): IdpUser['role_hint'] | undefined {
    const map = this.config.role_mapping;
    if (!map || groups.length === 0) return undefined;
    if (map.admin?.some(g => groups.includes(g)))   return 'admin';
    if (map.auditor?.some(g => groups.includes(g))) return 'auditor';
    if (map.viewer?.some(g => groups.includes(g)))  return 'viewer';
    return undefined;
  }
}
