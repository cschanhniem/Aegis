/**
 * SAML adapter tests.
 *
 * We mint a SAMLResponse INSIDE the test by spinning up samlify's
 * IdentityProvider with a self-signed cert + key (vendored constants
 * below), then feeding that response into our SamlAdapter and asserting
 * the resulting IdpUser is correct.
 *
 * This proves the full round-trip: SP requests login → IdP signs the
 * response → SP parses + verifies signature → maps SAML attributes
 * into the gateway's canonical IdpUser shape.
 *
 * Why an embedded IdP, not a network call: external IdPs are flaky in
 * CI and exposing real IdP creds is a non-starter. samlify is the same
 * library that real SAML IdPs use server-side, so a fixture-IdP
 * exercises identical signing + canonicalisation paths.
 */
import pino from 'pino';
import * as samlify from 'samlify';
import { SamlAdapter } from '../services/saml-adapter';
import type { SsoConfig } from '@agentguard/core-schema';

// The production adapter sets xmllint as the schema validator. In CI we
// don't ship the XSD files, so we install a permissive validator here
// for the round-trip tests. xmllint stays in production paths via the
// adapter module (this override is process-scoped but loaded AFTER the
// adapter import, so the last call wins).
samlify.setSchemaValidator({
  validate: async () => 'SUCCESS_VALIDATE_MESSAGE',
} as any);

// ── Test IdP keypair (RSA-2048, self-signed, expires 2027) ────────────
// Generated once with openssl; NOT a real production cert. The matching
// public cert is embedded in IDP_CERT_PEM; the private key signs the
// fixture SAMLResponse below. Both are committed for deterministic CI.
const IDP_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC+HtwUwpXh2nzH
EDu80JPupSGoPuP3RXhZghyQE/eXXrSirnvZhDTbrxTI9HLqLNeIVfZKbO+QYPtF
cuxK/nnbmpfW+nlCqAK/ffAta2VLsmQtYdEjSNFope0CESOMWvbemDx5FPK9RPuJ
P+7OX9KChKrc4XdzOunaoF3JUG9FfUbisPregkAimu/0S49iJd530cNGLeyqh/aE
M3YXW2ZCNBnh13BLb2s2cf17OV6KeLkYO193VVQ9cc8+ZFFCzzw64Vhe6j487OJh
D1l7lZ4eSD3KC9Xr0bfym477J2f54n/bydCc3NSX/emeBrhOmQrqovns/PDIEjRQ
eafcf6YZAgMBAAECggEANfQfA9s22sn86CcgtNRCbxK4yvzSB/3Uih5FCdRIytHL
FHHM3u1IbOGyVdcdd3xzTBMNGpDwqXoERPC4ww2Vum8UUSNy3yo74WkVjGYycHl3
OXPNfKRxHTAdYx1HB9FWxtPQMZJy0qitc4VLuZBy9qw8qwNnOTHKZMtm4jcr5L2L
ZR0okLvT3gaRebtPdOsJIRphmqcAxfUXbzFz3GQ1iFo0w8XJ94fNaPzH47QAsrEh
rkB3A+38B7YnOWqoQ5EacOQp98JD5LLw85F//fyKpde/GQS9jMGoEPKf1VaI6zD4
/ZKdlG8u0xUrgNJEuyV18ZcrssCxeud15OgLaYCR0wKBgQDyjqBjLerg6y7NnhqO
qp8mp/+6lwInz7EHAit1hnp8RAKa0ZABTj0eCYS/3G+u/QCYR9tYVeeAo0Yc3g0N
A1XNQuuf0R5JoCh6UFsYvMkzIbuadPubVS/cxCRWBcYOQ5ZGWgpmtn0bbB1DcI5c
Q0EgufGhrdeQ9TYMZir+hLLKZwKBgQDIqETKyQnifbSAUSEGxSj+mdl4hxSK1Lda
s8xtsYUuZSDVLoonZvBevfDF47jhbsNMU0fm3G1kvykPzyPol/Yq7/fULi9XIfSN
hnzwcW8z2OoWHHkA8Uhh1PA+UgD17EGcEvuf5cWD976PXrA+LuwRfL9Iwzmo+Vp2
U6z+Eey7fwKBgBZ0U666ynql6wBH+adpbjBS7x6j6iQrWvUOI13O5Dnqxd71NYKZ
bpkAQpTMYF5vt4VhaZHk6fiDpPL5L3Yb7+5/mnaCEm64b+ba14QTvgCIx+hFmiFI
IpUqZz67bBlX8mpy3XGixTQrrw3WNqed5kKUVCUmhcU6nhVJxAMp369TAoGAMOPO
3xncrrKyKBGcWmnvcxlJQ3SmLK1nf1IPnSqDqKo7NbYBM1iBeJQO9ihmA4dZTl98
RWOvw7xP5OozdZiRAiU13Rzjq/c5/sGl72+0CI3xezG0yeYAHNYlMwoH8eN+mOiH
Jo51cZILfCM2DfCg1CHw+WmXwvP+dpYssDrt00ECgYBS1ZEDF4LhfnbZLK+sQCRr
r6NTvtdHoQyls6ESKLZw8lBhYlTHCAAbR7/VJIDeryTqMNjv84iEUZYWvJimxDSM
ICxzL6cJOHl8/I3VcNtEsgee6WrGs9NV1/HyDuVzO3feagyRikRJ4Ox67v8ZClCL
GmfAl7r6TTzlj/yhkBa2Zw==
-----END PRIVATE KEY-----`;
const IDP_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDBzCCAe+gAwIBAgIUTjUxeArbYaPRTSDpWHynj60Dd5IwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIdGVzdC1pZHAwHhcNMjYwNjA0MDAyOTMwWhcNMjcwNjA0
MDAyOTMwWjATMREwDwYDVQQDDAh0ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAL4e3BTCleHafMcQO7zQk+6lIag+4/dFeFmCHJAT95detKKu
e9mENNuvFMj0cuos14hV9kps75Bg+0Vy7Er+edual9b6eUKoAr998C1rZUuyZC1h
0SNI0Wil7QIRI4xa9t6YPHkU8r1E+4k/7s5f0oKEqtzhd3M66dqgXclQb0V9RuKw
+t6CQCKa7/RLj2Il3nfRw0Yt7KqH9oQzdhdbZkI0GeHXcEtvazZx/Xs5Xop4uRg7
X3dVVD1xzz5kUULPPDrhWF7qPjzs4mEPWXuVnh5IPcoL1evRt/KbjvsnZ/nif9vJ
0Jzc1Jf96Z4GuE6ZCuqi+ez88MgSNFB5p9x/phkCAwEAAaNTMFEwHQYDVR0OBBYE
FDmr1pFGzbA+kEpVJRcCKBxJuqxNMB8GA1UdIwQYMBaAFDmr1pFGzbA+kEpVJRcC
KBxJuqxNMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAGneshG8
ZF0S+aMjWTDkBB4fb0OioU2TY9ycBR1liaLLkfSdov1Jr/hiyGcgFpVtbjDQTIVy
bvujGmKOO/P6p51RIqC1ZGhfxKO4HVgg22cbstqE/kRsnCsF5AKAa3N6lOObytvH
4VDrz2FumRQzW+AnR+kdO0tjVoAtwtPwAByNfOj7SGSkHOQfveOP2tdAi4O0NgZO
bY5eaefJXx8krkoMigJd/umQW9wiH93YJhUjgBZCyveRsUvlWA9X/A6azZQdWaxo
ZcOCYaRIW268G4zPtsigKkN/yfM4HG+vVMFA4TCg9BS2XWxWCuFYz3xBKKjZh2IJ
JiXRM0j7K2Tocds=
-----END CERTIFICATE-----`;

const SP_ENTITY = 'agentguard-test';
const SP_ACS    = 'https://gateway.test/api/v1/auth/saml/callback';

function makeConfig(extra: Partial<NonNullable<SsoConfig['saml']>> = {}): SsoConfig {
  return {
    enabled: true,
    provider: 'saml',
    saml: {
      idp_entity_id: 'urn:test-idp',
      idp_sso_url:   'https://idp.test/sso',
      idp_certificate_pem: IDP_CERT_PEM,
      sp_entity_id: SP_ENTITY,
      sp_acs_url:   SP_ACS,
      sign_authn_request: false,
      name_id_format: 'emailAddress',
      ...extra,
    },
  } as SsoConfig;
}

async function mintLoginResponse(opts: {
  email: string;
  groups?: string[];
  groupsAttr?: string;
  audience?: string;
  acs?: string;
}): Promise<string> {
  const idp = samlify.IdentityProvider({
    entityID: 'urn:test-idp',
    privateKey: IDP_KEY_PEM,
    signingCert: IDP_CERT_PEM,
    isAssertionEncrypted: false,
    singleSignOnService: [{
      Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
      Location: 'https://idp.test/sso',
    }],
  });
  const sp = samlify.ServiceProvider({
    entityID: opts.audience ?? SP_ENTITY,
    assertionConsumerService: [{
      Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
      Location: opts.acs ?? SP_ACS,
    }],
    nameIDFormat: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
  });
  const user: any = {
    email: opts.email,
    nameID: opts.email,
    nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    attributes: { email: opts.email, displayName: opts.email.split('@')[0] },
  };
  if (opts.groups) {
    const k = opts.groupsAttr ?? 'groups';
    user.attributes[k] = opts.groups;
  }
  // samlify accepts a customTagReplacement callback to fill the
  // {StatusCode}, {NameID}, {Audience}, etc. placeholders in its
  // built-in SAML response template. Without this, samlify emits the
  // template VERBATIM and the SP rejects on missing StatusCode.
  const now = new Date();
  const later = new Date(now.getTime() + 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString();
  const customTag = (template: string) => {
    const id = '_' + Math.random().toString(36).slice(2);
    const aid = '_' + Math.random().toString(36).slice(2);
    const attrStatement = opts.groups ? `<saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="displayName"><saml:AttributeValue>${opts.email.split('@')[0]}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="${opts.groupsAttr ?? 'groups'}">${opts.groups.map(g => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')}</saml:Attribute>
    </saml:AttributeStatement>` : `<saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="displayName"><saml:AttributeValue>${opts.email.split('@')[0]}</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>`;
    const filled = template
      .replace(/{ID}/g, id)
      .replace(/{AssertionID}/g, aid)
      .replace(/{IssueInstant}/g, fmt(now))
      .replace(/{Destination}/g, opts.acs ?? SP_ACS)
      .replace(/{InResponseTo}/g, '_req1')
      .replace(/{Issuer}/g, 'urn:test-idp')
      .replace(/{StatusCode}/g, 'urn:oasis:names:tc:SAML:2.0:status:Success')
      .replace(/{NameIDFormat}/g, 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress')
      .replace(/{NameID}/g, opts.email)
      .replace(/{SubjectConfirmationDataNotOnOrAfter}/g, fmt(later))
      .replace(/{SubjectRecipient}/g, opts.acs ?? SP_ACS)
      .replace(/{ConditionsNotBefore}/g, fmt(now))
      .replace(/{ConditionsNotOnOrAfter}/g, fmt(later))
      .replace(/{Audience}/g, opts.audience ?? SP_ENTITY)
      .replace(/{AuthnStatement}/g, `<saml:AuthnStatement AuthnInstant="${fmt(now)}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`)
      .replace(/{AttributeStatement}/g, attrStatement);
    return { id, context: filled };
  };
  const result: any = await idp.createLoginResponse(sp, null as any, 'post', user, customTag);
  // samlify with binding='post' returns { context } — the base64-encoded
  // SAMLResponse ready for the form-POST body.
  return result.context;
}

const silentLogger = pino({ level: 'silent' });

describe('SamlAdapter — construction + metadata', () => {
  test('builds with minimal valid config', () => {
    const a = new SamlAdapter(makeConfig(), silentLogger);
    expect(a.name).toBe('saml');
    const md = a.spMetadata();
    expect(md).toContain(SP_ENTITY);
    expect(md).toContain(SP_ACS);
  });

  test('throws when saml block is missing', () => {
    const bad: any = { enabled: true, provider: 'saml' };
    expect(() => new SamlAdapter(bad, silentLogger)).toThrow(/SAML config missing/);
  });

  test('redirectUrl rides RelayState for CSRF binding', () => {
    const a = new SamlAdapter(makeConfig(), silentLogger);
    const url = a.redirectUrl({ state: 'abc-csrf-state', redirect_uri: SP_ACS });
    expect(url).toContain('RelayState=abc-csrf-state');
    expect(url).toContain('https://idp.test/sso');
    expect(url).toContain('SAMLRequest=');
  });
});

describe('SamlAdapter — exchangeCode round-trip', () => {
  test('signed SAMLResponse parses into IdpUser with email + name', async () => {
    const resp = await mintLoginResponse({ email: 'alice@acme.com' });
    const adapter = new SamlAdapter(makeConfig(), silentLogger);
    const u = await adapter.exchangeCode({
      code: resp, state: 's', expected_state: 's', redirect_uri: SP_ACS,
    });
    expect(u.email).toBe('alice@acme.com');
    expect(u.provider).toBe('saml');
    expect(u.sub).toBe('alice@acme.com');
  });

  test('RelayState mismatch rejects (CSRF defence)', async () => {
    const resp = await mintLoginResponse({ email: 'a@b.com' });
    const adapter = new SamlAdapter(makeConfig(), silentLogger);
    await expect(adapter.exchangeCode({
      code: resp, state: 'fwd', expected_state: 'orig', redirect_uri: SP_ACS,
    })).rejects.toThrow(/RelayState mismatch/);
  });

  test('email-domain allowlist rejects out-of-domain logins', async () => {
    const resp = await mintLoginResponse({ email: 'mallory@evil.com' });
    const adapter = new SamlAdapter({
      ...makeConfig(),
      allowed_email_domains: ['acme.com'],
    }, silentLogger);
    await expect(adapter.exchangeCode({
      code: resp, state: 's', expected_state: 's', redirect_uri: SP_ACS,
    })).rejects.toThrow(/domain not allowed/);
  });

  test('group attribute maps to role_hint=admin', async () => {
    const resp = await mintLoginResponse({
      email: 'bob@acme.com',
      groups: ['admins', 'engineers'],
    });
    const adapter = new SamlAdapter({
      ...makeConfig(),
      role_mapping: { admin: ['admins'], auditor: [], viewer: [] },
    }, silentLogger);
    const u = await adapter.exchangeCode({
      code: resp, state: 's', expected_state: 's', redirect_uri: SP_ACS,
    });
    expect(u.role_hint).toBe('admin');
  });

  test('custom groups_attribute path is honoured (Azure-AD style)', async () => {
    const azureGroupsAttr = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups';
    const resp = await mintLoginResponse({
      email: 'carol@acme.com',
      groups: ['auditors'],
      groupsAttr: azureGroupsAttr,
    });
    const adapter = new SamlAdapter({
      ...makeConfig({ groups_attribute: azureGroupsAttr }),
      role_mapping: { admin: [], auditor: ['auditors'], viewer: [] },
    }, silentLogger);
    const u = await adapter.exchangeCode({
      code: resp, state: 's', expected_state: 's', redirect_uri: SP_ACS,
    });
    expect(u.role_hint).toBe('auditor');
  });
});
