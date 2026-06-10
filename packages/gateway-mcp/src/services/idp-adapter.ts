/**
 * IdP adapter contract — what every SSO provider implementation has
 * to expose to the gateway. Today only `MockIdpAdapter` is wired up
 * (used in tests and local dev); a `WorkOSAdapter` lands when we
 * decide to take the dependency on https://workos.com.
 *
 * The contract intentionally hides the protocol details (SAML
 * assertions vs OIDC ID tokens vs OAuth code-grant) — the gateway
 * only ever sees `IdpUser` payloads, which lets us switch adapters
 * without touching downstream code.
 *
 * Why an interface, not a class hierarchy:
 *   - Adapters are stateless services (config-in, payload-out).
 *   - We never need to compose them; the gateway uses at most one
 *     per org. A factory selects the right one based on the
 *     org's stored config and returns it as `IdpAdapter`.
 *   - Mocks are trivial — see MockIdpAdapter below.
 */

/** Canonical user payload returned by `exchangeCode`. Anything an
 *  adapter learned from the IdP that isn't on this shape is dropped
 *  — keeps the gateway's user model uniform across providers. */
export interface IdpUser {
  /** Stable, opaque IdP subject id (e.g. WorkOS `directory_user_id`,
   *  Okta `sub`). Used to detect repeat logins from the same human. */
  sub: string;
  email: string;
  name?: string;
  /** Optional role hint from the IdP (e.g. via group → role mapping).
   *  The gateway treats this as a *suggestion*; final role lives in
   *  the local `users` table where an admin can override. */
  role_hint?: 'admin' | 'auditor' | 'viewer';
  /** Provider name — recorded on the session so audit log can
   *  attribute which IdP authenticated the login. */
  provider: 'workos' | 'okta' | 'google' | 'azure-ad' | 'oidc-generic' | 'saml' | 'mock' | 'other';
}

export interface IdpAdapter {
  /** Provider name — usually equals what shows up in `IdpUser.provider`. */
  readonly name: string;

  /** Build the URL the Cockpit redirects the browser to so the IdP
   *  can authenticate the user. `state` is a CSRF-style nonce the
   *  gateway expects back unchanged in `exchangeCode`. */
  redirectUrl(opts: { state: string; redirect_uri: string }): string;

  /** Convert an IdP callback's `code` + `state` into an IdpUser
   *  payload. Must throw on any failure (state mismatch, code
   *  expired, IdP HTTP error) — callers translate that into a 4xx. */
  exchangeCode(opts: {
    code: string;
    state: string;
    expected_state: string;
    redirect_uri: string;
  }): Promise<IdpUser>;
}

/**
 * Mock adapter — used in tests and local dev. Skips the entire
 * IdP round-trip and returns a deterministic IdpUser derived from
 * the `code` argument. NEVER wire this into production routes.
 *
 *   const adapter = new MockIdpAdapter();
 *   adapter.redirectUrl({ state: 's', redirect_uri: 'http://x/cb' });
 *   // → 'mock://idp?state=s&redirect_uri=http%3A%2F%2Fx%2Fcb'
 *   await adapter.exchangeCode({ code: 'alice@example.com', ... });
 *   // → { sub: 'mock:alice@example.com', email: 'alice@example.com', ... }
 */
export class MockIdpAdapter implements IdpAdapter {
  readonly name = 'mock';

  redirectUrl(opts: { state: string; redirect_uri: string }): string {
    const sp = new URLSearchParams({ state: opts.state, redirect_uri: opts.redirect_uri });
    return `mock://idp?${sp.toString()}`;
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
    // The `code` doubles as an email address in mock mode — useful for
    // tests that need to vary the user identity per call.
    const email = opts.code.includes('@') ? opts.code : `${opts.code}@example.com`;
    return {
      sub: `mock:${email}`,
      email,
      name: email.split('@')[0],
      provider: 'mock',
    };
  }
}

/**
 * Stub for the planned WorkOS adapter. Construction throws so the
 * gateway can't accidentally wire it before the integration is real.
 * When implementing, replace the throw with the actual SDK call —
 * see https://workos.com/docs/sso/guide. The constructor takes the
 * api key + org-side config (client_id, etc.) so the contract
 * doesn't change for downstream code.
 */
export class WorkOSAdapter implements IdpAdapter {
  readonly name = 'workos';

  constructor(_apiKey: string, _clientId: string) {
    throw new Error(
      'WorkOSAdapter is not yet implemented. Wire @workos-inc/node SDK ' +
      'and set redirectUrl / exchangeCode against WorkOS SSO API.',
    );
  }

  redirectUrl(_opts: { state: string; redirect_uri: string }): string {
    throw new Error('WorkOSAdapter unimplemented');
  }

  async exchangeCode(_opts: {
    code: string; state: string; expected_state: string; redirect_uri: string;
  }): Promise<IdpUser> {
    throw new Error('WorkOSAdapter unimplemented');
  }
}
