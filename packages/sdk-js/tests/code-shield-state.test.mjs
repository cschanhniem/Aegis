/**
 * Tests for the CodeShield closed-loop buffer.
 *
 * Run with: node --test tests/
 * No deps required — Node 22's built-in test runner.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _csRecord as record,
  _csConsume as consume,
  _csReset as reset,
  _csToCheckPayload as toCheckPayload,
  _CS_TTL_MS as TTL_MS,
} from '../dist/index.mjs';

describe('CodeShield state buffer', () => {
  beforeEach(() => reset());

  it('records and consumes a verdict (round-trip)', () => {
    const v = { worst: 'HIGH', unique_findings: 2, findings: [{ rule: 'py.exec' }] };
    record('agent-a', v);
    assert.deepEqual(consume('agent-a'), v);
  });

  it('consume is single-use (second call returns null)', () => {
    record('agent-a', { worst: 'LOW' });
    assert.ok(consume('agent-a'));
    assert.equal(consume('agent-a'), null);
  });

  it('consume returns null for unknown agents', () => {
    assert.equal(consume('never-seen'), null);
  });

  it('rejects blank agent id and non-object results', () => {
    record('', { worst: 'HIGH' });
    assert.equal(consume(''), null);

    record('agent-x', null);
    assert.equal(consume('agent-x'), null);
  });

  it('TTL constant is exactly 30 seconds', () => {
    // Lock the spec — if someone changes this, tests force them
    // to update the docstring + ROADMAP + CHANGELOG too.
    assert.equal(TTL_MS, 30_000);
  });
});

describe('CodeShield toCheckPayload projection', () => {
  it('projects worst severity + findings_count + rules', () => {
    const out = toCheckPayload({
      worst: 'CRITICAL',
      unique_findings: 3,
      findings: [
        { rule: 'py.eval' },
        { rule: 'py.eval' },        // duplicate — collapsed
        { rule: 'sh.rm-rf-root' },
        { rule: 'junk' },
      ],
    });
    assert.equal(out.worst, 'CRITICAL');
    assert.equal(out.findings_count, 3);
    assert.deepEqual(out.rules, ['py.eval', 'sh.rm-rf-root', 'junk']);
  });

  it('falls back to findings.length when unique_findings absent', () => {
    const out = toCheckPayload({
      worst: 'MEDIUM',
      findings: [{ rule: 'x' }, { rule: 'y' }],
    });
    assert.equal(out.findings_count, 2);
  });

  it('handles clean scan (worst=null)', () => {
    const out = toCheckPayload({ worst: null, unique_findings: 0, findings: [] });
    assert.equal(out.worst, null);
    assert.equal(out.findings_count, 0);
    assert.equal(out.rules, undefined);
  });

  it('normalizes unknown worst values to null', () => {
    const out = toCheckPayload({ worst: 'BANANAS' });
    assert.equal(out.worst, null);
  });

  it('caps rules list at 64 entries to match gateway zod bound', () => {
    const findings = Array.from({ length: 200 }, (_, i) => ({ rule: `r${i}` }));
    const out = toCheckPayload({ worst: 'HIGH', unique_findings: 200, findings });
    assert.equal(out.rules.length, 64);
  });

  it('drops rules with bad shape (non-string, oversized)', () => {
    const out = toCheckPayload({
      worst: 'HIGH',
      findings: [
        { rule: 'good' },
        { rule: 123 },                 // wrong type
        { rule: 'a'.repeat(200) },     // too long
        {},                            // missing
      ],
    });
    assert.deepEqual(out.rules, ['good']);
  });
});
