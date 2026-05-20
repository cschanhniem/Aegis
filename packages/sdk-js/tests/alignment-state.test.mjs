/**
 * Tests for the alignment closed-loop buffer.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _alignRecord as record,
  _alignConsume as consume,
  _alignReset as reset,
  _alignToCheckPayload as toCheckPayload,
  _ALIGN_TTL_MS as TTL_MS,
} from '../dist/index.mjs';

describe('alignment state buffer', () => {
  beforeEach(() => reset());

  it('round-trip', () => {
    const v = { score: 0.42, drifted: true, signals: ['scope-expansion'] };
    record('agent-a', v);
    assert.deepEqual(consume('agent-a'), v);
  });

  it('single-use', () => {
    record('agent-a', { score: 0.9 });
    assert.ok(consume('agent-a'));
    assert.equal(consume('agent-a'), null);
  });

  it('rejects blank id + non-object', () => {
    record('', { score: 0.5 });
    assert.equal(consume(''), null);
    record('agent-x', null);
    assert.equal(consume('agent-x'), null);
  });

  it('TTL constant is 30s', () => {
    assert.equal(TTL_MS, 30_000);
  });
});

describe('alignment toCheckPayload projection', () => {
  it('clamps score and truncates signals', () => {
    const out = toCheckPayload({
      score: 1.5,
      drifted: true,
      signals: ['x'.repeat(80), 'short'].concat(Array.from({ length: 10 }, (_, i) => `s${i}`)),
      reason: 'r'.repeat(900),
      junk: 'ignored',
    });
    assert.equal(out.score, 1.0);
    assert.equal(out.drifted, true);
    assert.equal(out.signals.length, 5);
    assert.equal(out.signals[0].length, 40);
    assert.equal(out.reason.length, 500);
    assert.equal(out.junk, undefined);
  });

  it('clamps negative score to 0', () => {
    const out = toCheckPayload({ score: -0.5 });
    assert.equal(out.score, 0.0);
  });

  it('returns null when score is missing or non-numeric', () => {
    assert.equal(toCheckPayload({}), null);
    assert.equal(toCheckPayload({ score: 'high' }), null);
    assert.equal(toCheckPayload({ score: NaN }), null);
  });

  it('omits signals / drifted / reason if absent', () => {
    const out = toCheckPayload({ score: 0.5 });
    assert.equal(out.score, 0.5);
    assert.equal(out.signals, undefined);
    assert.equal(out.drifted, undefined);
    assert.equal(out.reason, undefined);
  });
});
