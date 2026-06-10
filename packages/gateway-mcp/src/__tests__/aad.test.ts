import { ActiveAnomalyDiscovery } from '../services/aad';

describe('ActiveAnomalyDiscovery', () => {
  it('returns unweighted mean before minFeedbacks reached', () => {
    const a = new ActiveAnomalyDiscovery({ numTrees: 4, minFeedbacks: 5 });
    const r = a.reweight([0.2, 0.4, 0.6, 0.8]);
    expect(r.usedFeedback).toBe(false);
    expect(r.score).toBeCloseTo(0.5, 3);
  });

  it('after sufficient feedback, weights diverge and reweighted score moves', () => {
    const a = new ActiveAnomalyDiscovery({ numTrees: 4, minFeedbacks: 4 });
    // Imagine trees 0 and 1 contribute a lot to TP anomalies; 2 and 3 are noisy.
    // Feed several TP examples where the first two tree-scores are HIGH.
    for (let i = 0; i < 8; i++) a.feedback([0.9, 0.9, 0.1, 0.1], 'tp');
    // And FPs where trees 2 and 3 had high contribution (so they
    // should be DEMOTED).
    for (let i = 0; i < 8; i++) a.feedback([0.1, 0.1, 0.9, 0.9], 'fp');

    const w = a.inspectWeights();
    // After this, weights on trees 0 and 1 should be larger than 2 and 3
    const out = a.reweight([0.9, 0.9, 0.1, 0.1]);
    const out2 = a.reweight([0.1, 0.1, 0.9, 0.9]);
    expect(out.usedFeedback).toBe(true);
    expect(out.score).toBeGreaterThan(out2.score);
  });

  it('weight clamping keeps weights within [0, maxWeight]', () => {
    const a = new ActiveAnomalyDiscovery({ numTrees: 3, minFeedbacks: 1, maxWeight: 2 });
    // Feed many TPs all in one direction to push weights up
    for (let i = 0; i < 200; i++) a.feedback([1, 1, 1], 'tp');
    const w = a.inspectWeights();
    expect(w.max).toBeLessThanOrEqual(2);
    expect(w.min).toBeGreaterThanOrEqual(0);
  });

  it('serialize → deserialize preserves the model', () => {
    const a = new ActiveAnomalyDiscovery({ numTrees: 5, minFeedbacks: 3 });
    for (let i = 0; i < 10; i++) a.feedback([Math.random(), 0.5, 0.5, 0.5, 0.5], 'tp');
    const snap = a.serialize();
    const b = ActiveAnomalyDiscovery.deserialize(snap);
    expect(b.totalFeedbacks).toBe(a.totalFeedbacks);
    const s = [0.5, 0.5, 0.5, 0.5, 0.5];
    expect(b.reweight(s).score).toBeCloseTo(a.reweight(s).score, 6);
  });

  it('rejects mismatched feature length silently', () => {
    const a = new ActiveAnomalyDiscovery({ numTrees: 4 });
    a.feedback([0.5, 0.5], 'tp');     // wrong length
    expect(a.totalFeedbacks).toBe(0);
    const r = a.reweight([0.5, 0.5]); // wrong length
    expect(r.score).toBe(0);
  });

  it('tp+fp counters reflect history', () => {
    const a = new ActiveAnomalyDiscovery({ numTrees: 2, minFeedbacks: 1 });
    a.feedback([0.5, 0.5], 'tp');
    a.feedback([0.5, 0.5], 'tp');
    a.feedback([0.5, 0.5], 'fp');
    expect(a.truePositives).toBe(2);
    expect(a.falsePositives).toBe(1);
    expect(a.totalFeedbacks).toBe(3);
  });
});
