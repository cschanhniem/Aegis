/**
 * auditActor — formats key-name + key-prefix from the auth
 * middleware into the (user_email, user_id) pair the audit log
 * service expects. API-key callers don't have a real user, but
 * SOC 2 reviewers still need to answer "which key did this?".
 */

import type { Request } from 'express';
import { auditActor } from '../middleware/auth';

function reqWith(extra: Partial<Request>): Request {
  // Bare-minimum mock — auditActor only reads keyName / keyPrefix.
  return extra as Request;
}

describe('auditActor', () => {
  test('formats name + prefix when both present', () => {
    const out = auditActor(reqWith({ keyName: 'Default Key', keyPrefix: 'aegis_a1b' }));
    expect(out.user_email).toBe('Default Key (aegis_a1b)');
    expect(out.user_id).toBe('aegis_a1b');
  });

  test('falls back to name alone if no prefix', () => {
    const out = auditActor(reqWith({ keyName: 'Default Key' }));
    expect(out.user_email).toBe('Default Key');
    expect(out.user_id).toBeUndefined();
  });

  test('falls back to prefix alone if no name', () => {
    const out = auditActor(reqWith({ keyPrefix: 'dash_5678' }));
    expect(out.user_email).toBe('dash_5678');
    expect(out.user_id).toBe('dash_5678');
  });

  test('returns empty object when no auth context', () => {
    expect(auditActor(reqWith({}))).toEqual({});
  });
});
