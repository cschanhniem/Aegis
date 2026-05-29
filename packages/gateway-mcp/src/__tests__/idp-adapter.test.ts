/**
 * IdP adapter contract — covers the MockIdpAdapter end-to-end and
 * the WorkOSAdapter stub's refusal-to-construct.
 */
import { MockIdpAdapter, WorkOSAdapter, IdpAdapter, IdpUser } from '../services/idp-adapter';

describe('MockIdpAdapter', () => {
  const adapter: IdpAdapter = new MockIdpAdapter();

  test('redirectUrl carries state + redirect_uri', () => {
    const url = adapter.redirectUrl({ state: 'abc', redirect_uri: 'http://localhost/cb' });
    expect(url.startsWith('mock://idp?')).toBe(true);
    expect(url).toContain('state=abc');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%2Fcb');
  });

  test('exchangeCode returns deterministic IdpUser when code looks like email', async () => {
    const user: IdpUser = await adapter.exchangeCode({
      code: 'alice@example.com',
      state: 's',
      expected_state: 's',
      redirect_uri: 'http://localhost/cb',
    });
    expect(user.email).toBe('alice@example.com');
    expect(user.sub).toBe('mock:alice@example.com');
    expect(user.name).toBe('alice');
    expect(user.provider).toBe('mock');
  });

  test('exchangeCode synthesises @example.com when code is a bare handle', async () => {
    const user = await adapter.exchangeCode({
      code: 'bob',
      state: 's',
      expected_state: 's',
      redirect_uri: 'http://localhost/cb',
    });
    expect(user.email).toBe('bob@example.com');
  });

  test('exchangeCode rejects on state mismatch', async () => {
    await expect(
      adapter.exchangeCode({
        code: 'a@b.c', state: 'one', expected_state: 'other', redirect_uri: 'http://x/cb',
      }),
    ).rejects.toThrow(/state mismatch/);
  });
});

describe('WorkOSAdapter (stub)', () => {
  test('constructor throws — keeps unimplemented adapter out of routes', () => {
    expect(() => new WorkOSAdapter('key', 'client')).toThrow(/not yet implemented/i);
  });
});
