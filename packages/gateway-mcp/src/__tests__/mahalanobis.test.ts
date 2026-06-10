import { MahalanobisScorer } from '../services/mahalanobis';

function gaussian2d(n: number, mu: [number, number], cov: [[number, number], [number, number]], seed = 1): number[][] {
  // Cholesky of 2x2 cov, then Box-Muller.
  const a = Math.sqrt(cov[0][0]);
  const b = cov[0][1] / a;
  const c = Math.sqrt(Math.max(cov[1][1] - b * b, 1e-12));
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s & 0xfffffff) / 0xfffffff;
  };
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const z2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
    out.push([mu[0] + a * z1, mu[1] + b * z1 + c * z2]);
  }
  return out;
}

describe('MahalanobisScorer', () => {
  it('returns 0 score before minSamples is reached', () => {
    const s = new MahalanobisScorer();
    for (let i = 0; i < 5; i++) s.update([i, i + 1]);
    expect(s.score([100, 100])).toBe(0);
  });

  it('typical (mean-centered) point scores near 0', () => {
    const s = new MahalanobisScorer();
    // Train on N(0, I) — diagonal cov, mean at origin
    for (const p of gaussian2d(200, [0, 0], [[1, 0], [0, 1]], 42)) s.update(p);
    const score = s.score([0, 0]);
    expect(score).toBeLessThan(0.5);
  });

  it('off-axis correlated anomaly scores high even when each dim is normal', () => {
    // Train on highly correlated data: y ≈ x.
    const s = new MahalanobisScorer();
    for (const p of gaussian2d(500, [0, 0], [[1, 0.95], [0.95, 1]], 7)) s.update(p);
    // x=1, y=-1 — each marginally plausible but breaks correlation.
    const off = s.score([1, -1]);
    const on  = s.score([1, 1]);
    expect(off).toBeGreaterThan(on * 5);   // wide separation: the off-diagonal
                                            // anomaly must register much higher.
  });

  it('pValue follows the chi-square tail roughly', () => {
    const s = new MahalanobisScorer();
    for (const p of gaussian2d(500, [0, 0], [[1, 0], [0, 1]], 99)) s.update(p);
    // d² = 9 with d=2 → very rare; p should be small.
    const farScore = s.score([3, 3]);
    const farP = s.pValue(farScore);
    const nearScore = s.score([0.1, 0.1]);
    const nearP = s.pValue(nearScore);
    expect(farP).toBeLessThan(0.1);
    expect(nearP).toBeGreaterThan(0.5);
  });

  it('serialize → deserialize preserves the scorer', () => {
    const a = new MahalanobisScorer();
    for (const p of gaussian2d(50, [1, 2], [[1, 0.3], [0.3, 1]], 5)) a.update(p);
    const snap = a.serialize();
    const b = MahalanobisScorer.deserialize(snap);
    expect(b.samples).toBe(a.samples);
    expect(b.featureDim).toBe(a.featureDim);
    expect(b.score([0, 0])).toBeCloseTo(a.score([0, 0]), 6);
  });

  it('shrinkage keeps the inverse stable when d > n', () => {
    // Stress: 16-dim space, only 30 samples (n < d²). Without
    // shrinkage the inverse would blow up; with λ=0.1 it should
    // remain finite and produce a meaningful score.
    const s = new MahalanobisScorer({ shrinkage: 0.10, minSamples: 20 });
    let rs = 7;
    const rand = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return (rs & 0x7fffffff) / 0x7fffffff; };
    for (let i = 0; i < 30; i++) {
      s.update(Array.from({ length: 16 }, () => rand()));
    }
    const out = s.score(Array.from({ length: 16 }, () => rand()));
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThanOrEqual(0);
  });
});
