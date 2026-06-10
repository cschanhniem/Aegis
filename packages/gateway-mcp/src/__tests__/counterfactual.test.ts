/**
 * Counterfactual explainer tests. Pins:
 *   - For each AJV keyword class, the suggested edit ACTUALLY makes
 *     the call pass (verified=true).
 *   - Suggestion text is human-readable.
 *   - Guidance falls back when no concrete edit is possible.
 *   - No mutation of the original args (cloned edits).
 */
import { explainBlock } from '../services/counterfactual';

describe('counterfactual explainer — each keyword class', () => {
  test('pattern violation on https-only URL — suggests an HTTPS URL', () => {
    const schema = {
      type: 'object',
      properties: { url: { type: 'string', pattern: '^https://' } },
      required: ['url'], additionalProperties: true,
    };
    const r = explainBlock(schema, { url: 'http://insecure.example' });
    expect(r.any_suggestion).toBe(true);
    const s = r.suggestions.find(s => s.fix_kind === 'pattern')!;
    expect(s.description).toMatch(/match/i);
    expect(s.proposed_arguments.url).toMatch(/^https:\/\//);
    expect(s.verified).toBe(true);
  });

  test('maxLength violation — suggests truncation', () => {
    const schema = {
      type: 'object',
      properties: { note: { type: 'string', maxLength: 10 } },
      additionalProperties: true,
    };
    const r = explainBlock(schema, { note: 'this is way too long for the schema' });
    const s = r.suggestions.find(s => s.fix_kind === 'maxLength')!;
    expect(s.proposed_arguments.note.length).toBe(10);
    expect(s.verified).toBe(true);
  });

  test('enum violation — proposes closest enum value', () => {
    const schema = {
      type: 'object',
      properties: { method: { enum: ['GET', 'HEAD'] } },
      additionalProperties: true,
    };
    const r = explainBlock(schema, { method: 'POST' });
    const s = r.suggestions.find(s => s.fix_kind === 'enum')!;
    expect(['GET', 'HEAD']).toContain(s.proposed_arguments.method);
    expect(s.verified).toBe(true);
  });

  test('required violation — proposes providing the missing field', () => {
    const schema = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: true,
    };
    const r = explainBlock(schema, {});
    const s = r.suggestions.find(s => s.fix_kind === 'required')!;
    expect(s.description).toMatch(/missing field "id"/);
    // verified may be true (empty string passes type:string) or guidance offered.
    expect(s.proposed_arguments).toHaveProperty('id');
  });

  test('additionalProperties violation — proposes removing the offending key', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    };
    const r = explainBlock(schema, { name: 'alice', evil: 1 });
    const s = r.suggestions.find(s => s.fix_kind === 'additionalProperties')!;
    expect(s.description).toMatch(/Remove disallowed field "evil"/);
    expect(s.proposed_arguments).not.toHaveProperty('evil');
    expect(s.verified).toBe(true);
  });

  test('not.pattern (denylist) — guidance only, no auto-fix', () => {
    const schema = {
      type: 'object',
      properties: { sql: { type: 'string', not: { pattern: 'DROP TABLE' } } },
      additionalProperties: true,
    };
    const r = explainBlock(schema, { sql: 'SELECT 1; DROP TABLE users;' });
    // We surface guidance text — auto-rewriting denylist is unsafe to do.
    expect(r.guidance.some(g => /denylist|forbidden/i.test(g))).toBe(true);
  });

  test('type violation — guidance only (no safe default)', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      additionalProperties: true,
    };
    const r = explainBlock(schema, { count: 'not a number' });
    expect(r.guidance.some(g => /type integer/i.test(g))).toBe(true);
  });

  test('input is not mutated by the explainer', () => {
    const original = { url: 'http://x.com' };
    const snapshot = JSON.parse(JSON.stringify(original));
    const schema = {
      type: 'object',
      properties: { url: { type: 'string', pattern: '^https://' } },
      additionalProperties: true,
    };
    explainBlock(schema, original);
    expect(original).toEqual(snapshot);
  });

  test('valid call — no suggestions, no guidance', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string' } },
      additionalProperties: true,
    };
    const r = explainBlock(schema, { x: 'ok' });
    expect(r.any_suggestion).toBe(false);
    expect(r.guidance).toEqual([]);
    expect(r.suggestions).toEqual([]);
  });

  test('multiple violations — multiple suggestions returned', () => {
    const schema = {
      type: 'object',
      properties: {
        url:    { type: 'string', pattern: '^https://' },
        method: { enum: ['GET', 'HEAD'] },
      },
      required: ['url'],
      additionalProperties: true,
    };
    const r = explainBlock(schema, { url: 'http://x', method: 'POST' });
    expect(r.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(r.suggestions.some(s => s.fix_kind === 'pattern')).toBe(true);
    expect(r.suggestions.some(s => s.fix_kind === 'enum')).toBe(true);
  });
});
