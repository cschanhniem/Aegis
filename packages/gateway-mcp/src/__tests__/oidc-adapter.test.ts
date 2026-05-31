import { OidcAdapter } from '../services/oidc-adapter';
import { IdpFactory } from '../services/idp-factory';
import { MockIdpAdapter } from '../services/idp-adapter';
import { SsoConfigSchema } from '@agentguard/core-schema';
import { TenantConfigService } from '../services/tenant-config';
import { ConfigBus } from '../services/config-bus';
import { AuditLogService } from '../services/audit-log';
import Database from 'better-sqlite3';
import pino from 'pino';

const OKTA_DISCOVERY = {
  issuer: 'https://acme.okta.com/oauth2/default',
  authorization_endpoint: 'https://acme.okta.com/oauth2/default/v1/authorize',
  token_endpoint:         'https://acme.okta.com/oauth2/default/v1/token',
  userinfo_endpoint:      'https://acme.okta.com/oauth2/default/v1/userinfo',
};

const AZURE_DISCOVERY = {
  issuer: 'https://login.microsoftonline.com/abc/v2.0',
  authorization_endpoint: 'https://login.microsoftonline.com/abc/oauth2/v2.0/authorize',
  token_endpoint:         'https://login.microsoftonline.com/abc/oauth2/v2.0/token',
  userinfo_endpoint:      'https://graph.microsoft.com/oidc/userinfo',
};

const GOOGLE_DISCOVERY = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint:         'https://oauth2.googleapis.com/token',
  userinfo_endpoint:      'https://openidconnect.googleapis.com/v1/userinfo',
};

function okta(over: any = {}): any {
  return SsoConfigSchema.parse({
    enabled: true,
    provider: 'okta',
    issuer: 'https://acme.okta.com/oauth2/default',
    client_id: 'oa1abc',
    client_secret: 'secret-redacted',
    ...over,
  });
}

function azure(over: any = {}): any {
  return SsoConfigSchema.parse({
    enabled: true,
    provider: 'azure-ad',
    issuer: 'https://login.microsoftonline.com/abc/v2.0',
    client_id: 'azure-app-1',
    client_secret: 'secret-redacted',
    ...over,
  });
}

function google(over: any = {}): any {
  return SsoConfigSchema.parse({
    enabled: true,
    provider: 'google',
    issuer: 'https://accounts.google.com',
    client_id: 'google-client',
    client_secret: 'secret',
    ...over,
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    return handler(typeof input === 'string' ? input : String(input), init ?? {});
  });
}

afterEach(() => jest.restoreAllMocks());

// ── Construction ────────────────────────────────────────────────────────

describe('OidcAdapter construction', () => {
  it('rejects mock provider', () => {
    expect(() => new OidcAdapter({ enabled: true, provider: 'mock' } as any)).toThrow();
  });
  it('rejects workos (stubbed elsewhere)', () => {
    expect(() => new OidcAdapter({ enabled: true, provider: 'workos' } as any)).toThrow();
  });
  it('rejects missing issuer / client_id / client_secret', () => {
    expect(() => new OidcAdapter({ enabled: true, provider: 'okta' } as any)).toThrow();
  });
  it('accepts a valid Okta config', () => {
    const a = new OidcAdapter(okta());
    expect(a.name).toBe('okta');
  });
});

// ── redirectUrl ─────────────────────────────────────────────────────────

describe('OidcAdapter redirectUrl', () => {
  it('builds an authorize URL with state + scopes', () => {
    const a = new OidcAdapter(okta());
    const url = a.redirectUrl({ state: 's_abc', redirect_uri: 'https://app/callback' });
    // Without prefetched discovery, adapter falls back to the standard
    // /oauth2/v1/authorize path appended to the issuer.
    expect(url).toMatch(/^https:\/\/acme\.okta\.com\/oauth2\/default\/oauth2\/v1\/authorize\?/);
    expect(url).toMatch(/response_type=code/);
    expect(url).toMatch(/state=s_abc/);
    expect(url).toMatch(/client_id=oa1abc/);
    expect(url).toMatch(/scope=openid\+profile\+email\+groups/);
    expect(url).toMatch(/redirect_uri=https%3A%2F%2Fapp%2Fcallback/);
  });

  it('Google preset omits groups scope by default', () => {
    const url = new OidcAdapter(google()).redirectUrl({ state: 'x', redirect_uri: 'https://app/cb' });
    expect(url).toMatch(/scope=openid\+profile\+email(?!\+groups)/);
  });

  it('custom scopes override the preset defaults', () => {
    const url = new OidcAdapter(okta({ scopes: ['openid', 'custom_scope'] })).redirectUrl({
      state: 'x', redirect_uri: 'https://app/cb',
    });
    expect(url).toMatch(/scope=openid\+custom_scope/);
  });
});

// ── exchangeCode (mocked HTTP) ─────────────────────────────────────────

describe('OidcAdapter exchangeCode (Okta path)', () => {
  it('returns an IdpUser with email + sub + provider tag', async () => {
    let calls: string[] = [];
    mockFetch(async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify(OKTA_DISCOVERY), { status: 200 });
      }
      if (url === OKTA_DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ access_token: 'at-1', id_token: 'idt-1' }), { status: 200 });
      }
      if (url === OKTA_DISCOVERY.userinfo_endpoint) {
        return new Response(JSON.stringify({
          sub: 'okta:u-1', email: 'Alice@Acme.com', name: 'Alice',
          groups: ['platform-admins'],
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const a = new OidcAdapter(okta({
      role_mapping: { admin: ['platform-admins'] },
    }));
    const user = await a.exchangeCode({
      code: 'c1', state: 's1', expected_state: 's1', redirect_uri: 'https://app/cb',
    });
    expect(user.email).toBe('alice@acme.com');  // normalized lowercase
    expect(user.sub).toBe('okta:u-1');
    expect(user.name).toBe('Alice');
    expect(user.provider).toBe('okta');
    expect(user.role_hint).toBe('admin');
    expect(calls.length).toBe(3);
  });

  it('rejects state mismatch up-front (no IdP calls made)', async () => {
    const fetchSpy = mockFetch(async () => new Response('', { status: 200 }));
    const a = new OidcAdapter(okta());
    await expect(a.exchangeCode({
      code: 'c1', state: 's1', expected_state: 'WRONG', redirect_uri: 'https://app/cb',
    })).rejects.toThrow(/state mismatch/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces allowed_email_domains', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(OKTA_DISCOVERY));
      if (url === OKTA_DISCOVERY.token_endpoint) return new Response(JSON.stringify({ access_token: 'at' }));
      if (url === OKTA_DISCOVERY.userinfo_endpoint) {
        return new Response(JSON.stringify({ sub: 'u', email: 'bob@evil.com' }));
      }
      return new Response('', { status: 404 });
    });
    const a = new OidcAdapter(okta({ allowed_email_domains: ['acme.com'] }));
    await expect(a.exchangeCode({
      code: 'c', state: 's', expected_state: 's', redirect_uri: 'https://app/cb',
    })).rejects.toThrow(/domain.*not in.*allow list/);
  });

  it('throws on token-endpoint non-2xx', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(OKTA_DISCOVERY));
      if (url === OKTA_DISCOVERY.token_endpoint) return new Response('invalid_grant', { status: 400 });
      return new Response('', { status: 200 });
    });
    const a = new OidcAdapter(okta());
    await expect(a.exchangeCode({
      code: 'c', state: 's', expected_state: 's', redirect_uri: 'https://app/cb',
    })).rejects.toThrow(/token exchange failed.*400/);
  });
});

describe('OidcAdapter exchangeCode (Azure + Google smoke)', () => {
  it('Azure AD: returns provider=azure-ad', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(AZURE_DISCOVERY));
      if (url === AZURE_DISCOVERY.token_endpoint) return new Response(JSON.stringify({ access_token: 'at' }));
      if (url === AZURE_DISCOVERY.userinfo_endpoint) return new Response(JSON.stringify({
        sub: 'aad-oid-x', email: 'eve@contoso.com', name: 'Eve',
      }));
      return new Response('', { status: 404 });
    });
    const user = await new OidcAdapter(azure()).exchangeCode({
      code: 'c', state: 's', expected_state: 's', redirect_uri: 'https://app/cb',
    });
    expect(user.provider).toBe('azure-ad');
    expect(user.sub).toBe('aad-oid-x');
  });

  it('Google: returns provider=google', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(GOOGLE_DISCOVERY));
      if (url === GOOGLE_DISCOVERY.token_endpoint) return new Response(JSON.stringify({ access_token: 'at' }));
      if (url === GOOGLE_DISCOVERY.userinfo_endpoint) return new Response(JSON.stringify({
        sub: 'g-1', email: 'carol@example.com', name: 'Carol',
      }));
      return new Response('', { status: 404 });
    });
    const user = await new OidcAdapter(google()).exchangeCode({
      code: 'c', state: 's', expected_state: 's', redirect_uri: 'https://app/cb',
    });
    expect(user.provider).toBe('google');
  });
});

// ── IdpFactory ──────────────────────────────────────────────────────────

function setupTenants() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, plan TEXT, settings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO organizations (id, name, slug, plan) VALUES ('default', 'd', 'd', 'community');
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, user_id TEXT, user_email TEXT, action TEXT,
      resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const logger = pino({ level: 'silent' });
  const audit = new AuditLogService(db, logger);
  const bus = new ConfigBus(logger);
  const tc = new TenantConfigService(db, logger, bus, audit);
  tc.seedDefaults();
  return { db, tc, factory: new IdpFactory(logger, tc) };
}

describe('IdpFactory.for', () => {
  it('returns Mock when SSO is disabled / absent', () => {
    const { factory } = setupTenants();
    const a = factory.for('default');
    expect(a).toBeInstanceOf(MockIdpAdapter);
  });

  it('returns OidcAdapter when sso.enabled with okta provider', () => {
    const { tc, factory } = setupTenants();
    tc.update('default', { sso: okta() }, { userEmail: 't' });
    const a = factory.for('default');
    expect(a.name).toBe('okta');
  });

  it('falls back to Mock when SSO config is incomplete', () => {
    const { tc, factory } = setupTenants();
    // enabled but missing client_id/secret → adapter construction will
    // throw inside the factory, which catches and returns Mock.
    tc.update('default', {
      sso: { enabled: true, provider: 'okta', issuer: 'https://x.okta.com' } as any,
    }, { userEmail: 't' });
    expect(factory.for('default')).toBeInstanceOf(MockIdpAdapter);
  });
});
