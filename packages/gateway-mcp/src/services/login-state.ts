/**
 * Login-state store — issues short-lived nonces that round-trip
 * through the IdP as the OAuth/SAML `state` parameter. Lets the
 * gateway detect CSRF + replay between the initial /login-url call
 * and the /callback call.
 *
 * In-memory by design — at v1.0 scale a gateway instance handles
 * its own logins. When we go multi-instance, this swaps for a
 * Redis-backed implementation behind the same interface.
 */

import { randomBytes } from 'crypto';

interface PendingLogin {
  state: string;
  /** Expires N ms from issue. Past this, /callback rejects. */
  expires_at: number;
  /** Optional intended redirect URI back into the Cockpit after login. */
  return_to?: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;  // 10 min — enough for IdP roundtrip

export class LoginStateStore {
  private states = new Map<string, PendingLogin>();

  /** Issue a fresh state + return the opaque token. */
  issue(opts: { return_to?: string; ttl_ms?: number } = {}): string {
    this.sweepExpired();
    const state = `s_${randomBytes(24).toString('base64url')}`;
    this.states.set(state, {
      state,
      expires_at: Date.now() + (opts.ttl_ms ?? DEFAULT_TTL_MS),
      return_to: opts.return_to,
    });
    return state;
  }

  /** Single-use consume — returns the pending login if state matches
   *  and is fresh; deletes it either way (one-shot semantics). */
  consume(state: string): PendingLogin | null {
    const row = this.states.get(state);
    if (!row) return null;
    this.states.delete(state);
    if (Date.now() > row.expires_at) return null;
    return row;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.states) {
      if (now > v.expires_at) this.states.delete(k);
    }
  }
}
