/**
 * SequenceAnomalyDetector tests. Pins the SOTA agent-security
 * contract:
 *
 *   1. Normal regular sequences yield LOW step_score after warm-up.
 *   2. Out-of-distribution tool injection produces HIGH step_score.
 *   3. Reordered (adversarial-shuffle) sequences are flagged via
 *      `unusual_pair`.
 *   4. Cold-start cap: first 5 observations contribute 0 to keep
 *      bootstrap from false-positiving.
 *   5. snapshot / restore round-trips without losing state.
 */
import { SequenceAnomalyDetector, sequenceContribution } from '../services/sequence-anomaly';

function train(d: SequenceAnomalyDetector, agentId: string, sequence: string[]): void {
  for (const t of sequence) d.scoreAndUpdate(agentId, t);
}

describe('SequenceAnomalyDetector — language-model anomaly', () => {
  test('cold-start observations contribute zero (no false positives at start)', () => {
    const d = new SequenceAnomalyDetector();
    for (let i = 0; i < 3; i++) {
      const r = d.scoreAndUpdate('a1', 'web_search');
      // Either step_score=0 OR baseline_size still below the contribution threshold.
      expect(sequenceContribution(r)).toBe(0);
    }
  });

  test('repeated normal sequence trains a strong baseline; subsequent same-tool call is well-predicted', () => {
    const d = new SequenceAnomalyDetector();
    // Customer-support style: 50 cycles of the same 3-call pattern.
    for (let i = 0; i < 50; i++) {
      d.scoreAndUpdate('a1', 'look_up_account');
      d.scoreAndUpdate('a1', 'check_balance');
      d.scoreAndUpdate('a1', 'send_email');
    }
    // After warm-up, replaying the same pattern should yield very LOW step_score.
    const r1 = d.scoreAndUpdate('a1', 'look_up_account');
    const r2 = d.scoreAndUpdate('a1', 'check_balance');
    const r3 = d.scoreAndUpdate('a1', 'send_email');
    expect(r1.step_score).toBeLessThan(3);
    expect(r2.step_score).toBeLessThan(3);
    expect(r3.step_score).toBeLessThan(3);
    expect(sequenceContribution(r2)).toBe(0);
  });

  test('out-of-distribution tool produces HIGH step_score and novel_call=true', () => {
    const d = new SequenceAnomalyDetector();
    for (let i = 0; i < 20; i++) {
      d.scoreAndUpdate('a1', 'look_up_account');
      d.scoreAndUpdate('a1', 'check_balance');
    }
    const r = d.scoreAndUpdate('a1', 'export_all_records');
    expect(r.novel_call).toBe(true);
    expect(r.step_score).toBeGreaterThan(5);
    expect(sequenceContribution(r)).toBeGreaterThanOrEqual(0.5);
  });

  test('adversarial shuffle: out-of-order known tool is flagged unusual_pair', () => {
    const d = new SequenceAnomalyDetector();
    // The agent ONLY ever does A → B → C → A → B → C ...
    for (let i = 0; i < 30; i++) {
      d.scoreAndUpdate('a1', 'A');
      d.scoreAndUpdate('a1', 'B');
      d.scoreAndUpdate('a1', 'C');
    }
    // Now an attacker forces A → C (skips B). Both tools are familiar,
    // but the (A → C) bigram has never been seen — it's a structural anomaly.
    d.scoreAndUpdate('a1', 'A');
    const r = d.scoreAndUpdate('a1', 'C');
    expect(r.novel_call).toBe(false);
    expect(r.unusual_pair).toBe(true);
    expect(sequenceContribution(r)).toBeGreaterThan(0);
  });

  test('per-agent isolation — agent A baseline does not affect agent B', () => {
    const d = new SequenceAnomalyDetector();
    train(d, 'a', ['X', 'Y', 'Z', 'X', 'Y', 'Z', 'X', 'Y', 'Z']);
    // Agent B has never been seen — first call is cold-start, contributes 0.
    const r = d.scoreAndUpdate('b', 'X');
    expect(r.baseline_size).toBe(1);
    expect(sequenceContribution(r)).toBe(0);
  });

  test('snapshot + restore round-trips state', () => {
    const d1 = new SequenceAnomalyDetector();
    train(d1, 'a1', Array.from({ length: 30 }, () => ['A', 'B', 'C']).flat());
    const blob = d1.snapshot('a1');
    expect(blob).not.toBeNull();
    const d2 = new SequenceAnomalyDetector();
    d2.restore('a1', blob!);
    // Restored detector continues to predict A → B as very likely.
    d2.scoreAndUpdate('a1', 'A');
    const r = d2.scoreAndUpdate('a1', 'B');
    expect(r.step_score).toBeLessThan(3);
  });

  test('restore handles malformed input by resetting the agent', () => {
    const d = new SequenceAnomalyDetector();
    d.restore('a1', 'not-json{');
    // Subsequent scoring works because the agent has been reset to empty.
    const r = d.scoreAndUpdate('a1', 'X');
    expect(r.baseline_size).toBe(1);
  });

  test('window_mean smooths burst noise across observations', () => {
    const d = new SequenceAnomalyDetector();
    // Heavy warm-up on a repeating cycle so the agent's history matures.
    for (let i = 0; i < 60; i++) d.scoreAndUpdate('a1', 'A');
    // A handful of novel tools should drive window_mean up, but it
    // should still be smaller than the individual spike.
    const spike = d.scoreAndUpdate('a1', 'NOVEL');
    expect(spike.step_score).toBeGreaterThan(spike.window_mean);
  });
});

describe('sequenceContribution — additive score for composite anomaly', () => {
  test('low step_score yields 0 contribution', () => {
    const r = { step_score: 1.5, window_mean: 1, is_anomaly: false, baseline_size: 100, novel_call: false, unusual_pair: false };
    expect(sequenceContribution(r)).toBe(0);
  });
  test('moderate step_score yields 0.25', () => {
    const r = { step_score: 4, window_mean: 3, is_anomaly: false, baseline_size: 100, novel_call: false, unusual_pair: false };
    expect(sequenceContribution(r)).toBe(0.25);
  });
  test('high step_score + novel + unusual caps at 1.0', () => {
    const r = { step_score: 9, window_mean: 5, is_anomaly: true, baseline_size: 100, novel_call: true, unusual_pair: true };
    expect(sequenceContribution(r)).toBe(1);
  });
  test('cold-start baseline (<5) contributes 0 regardless of score', () => {
    const r = { step_score: 10, window_mean: 8, is_anomaly: true, baseline_size: 2, novel_call: true, unusual_pair: true };
    expect(sequenceContribution(r)).toBe(0);
  });
});
