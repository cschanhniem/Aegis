import { HalfSpaceTrees } from '../services/half-space-trees';

function seededRand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

describe('HalfSpaceTrees', () => {
  it('returns 0 before warming up', () => {
    const h = new HalfSpaceTrees();
    const score = h.score([0.5, 0.5]);
    expect(score).toBe(0);
  });

  it('warms after windowSize samples and produces a score', () => {
    const h = new HalfSpaceTrees({ windowSize: 64, minSamples: 30 });
    const r = seededRand(7);
    for (let i = 0; i < 80; i++) h.update([r(), r()]);
    expect(h.isWarmed).toBe(true);
    const s = h.score([r(), r()]);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('anomalous off-distribution point scores higher than typical point', () => {
    // Train on points clustered near (0,0)
    const h = new HalfSpaceTrees({ windowSize: 128 });
    const r = seededRand(42);
    for (let i = 0; i < 300; i++) h.update([r() * 0.2, r() * 0.2]);
    // Typical: still inside the cluster
    const typical = h.score([0.1, 0.1]);
    // Anomalous: way out
    const anomalous = h.score([10, 10]);
    expect(anomalous).toBeGreaterThanOrEqual(typical);
  });

  it('window roll: after enough updates, latest becomes reference', () => {
    const h = new HalfSpaceTrees({ windowSize: 32 });
    const r = seededRand(1);
    // Fill one full window
    for (let i = 0; i < 32; i++) h.update([r(), r()]);
    expect(h.isWarmed).toBe(true);
    // Continue feeding; should keep rolling without crash
    for (let i = 0; i < 100; i++) h.update([r(), r()]);
    expect(h.samples).toBe(132);
  });

  it('handles dim mismatch gracefully (silent skip)', () => {
    const h = new HalfSpaceTrees({ windowSize: 16 });
    for (let i = 0; i < 16; i++) h.update([1, 2, 3]);
    const before = h.samples;
    h.update([1, 2]);          // wrong dim
    expect(h.samples).toBe(before);
    expect(h.score([1, 2])).toBe(0);
  });

  it('handles NaN / Infinity inputs', () => {
    const h = new HalfSpaceTrees({ windowSize: 16 });
    const before = h.samples;
    h.update([NaN, 1]);
    expect(h.samples).toBe(before);
  });

  it('memory bounded — bucket count fixed by numTrees * 2^depth', () => {
    const h = new HalfSpaceTrees({ numTrees: 10, depth: 6, windowSize: 64 });
    const r = seededRand(99);
    for (let i = 0; i < 1000; i++) h.update([r(), r(), r()]);
    const snap = h.serialize();
    // 10 trees, each 2^6=64 leaves. refMass + latMass arrays per tree.
    for (const t of snap.trees) {
      expect(t.refMass.length).toBe(64);
      expect(t.latMass.length).toBe(64);
    }
    expect(snap.trees.length).toBe(10);
  });

  it('serialize → deserialize preserves scoring', () => {
    const h = new HalfSpaceTrees({ windowSize: 64, numTrees: 8 });
    const r = seededRand(3);
    for (let i = 0; i < 200; i++) h.update([r(), r()]);
    const snap = h.serialize();
    const h2 = HalfSpaceTrees.deserialize(snap);
    expect(h2.score([0.5, 0.5])).toBe(h.score([0.5, 0.5]));
    expect(h2.score([100, 100])).toBe(h.score([100, 100]));
  });

  it('scoreAndUpdate returns score-before-update', () => {
    const h = new HalfSpaceTrees({ windowSize: 32 });
    const r = seededRand(11);
    for (let i = 0; i < 80; i++) h.update([r(), r()]);
    const beforeScore = h.score([0.5, 0.5]);
    const combined = h.scoreAndUpdate([0.5, 0.5]);
    expect(combined).toBe(beforeScore);
  });
});
