import { ConformalCalibrator } from '../services/conformal';

describe('ConformalCalibrator', () => {
  it('returns p=1 before the calibration buffer reaches minSamples', () => {
    const c = new ConformalCalibrator();
    for (let i = 0; i < 10; i++) c.addScore(Math.random());
    expect(c.pValue(0.99)).toBe(1);
  });

  it('high score relative to calibration buffer → small p', () => {
    const c = new ConformalCalibrator();
    for (let i = 0; i < 200; i++) c.addScore(Math.random() * 0.5);
    // Score of 5.0 is way above the buffer (max ~0.5).
    expect(c.pValue(5.0)).toBeLessThan(0.01);
  });

  it('typical score → p near 0.5', () => {
    const c = new ConformalCalibrator();
    for (let i = 0; i < 500; i++) c.addScore(i / 500);   // [0,1] uniform
    const p = c.pValue(0.5);
    expect(p).toBeGreaterThan(0.45);
    expect(p).toBeLessThan(0.55);
  });

  it('marginal validity: under iid normal data, P(p ≤ alpha) ≤ alpha (small alpha)', () => {
    // Empirical false-positive rate test. Build a 1000-sample buffer
    // from a single distribution, then query 1000 fresh samples from
    // the same distribution. Reject H0 (uniform) only when the
    // empirical rate is more than 3x the nominal — that's a generous
    // tolerance that should never fire under correct implementation.
    let s = 1;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s & 0x7fffffff) / 0x7fffffff; };
    const c = new ConformalCalibrator();
    for (let i = 0; i < 1000; i++) c.addScore(rand());
    let triggered = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (c.pValue(rand()) <= 0.05) triggered++;
    }
    const rate = triggered / N;
    // Nominal 5%; we should see ~5% in expectation. Allow [2%, 10%]
    // to be robust against the small simulation size.
    expect(rate).toBeGreaterThanOrEqual(0.02);
    expect(rate).toBeLessThanOrEqual(0.10);
  });

  it('sliding window evicts old scores after windowSize', () => {
    const c = new ConformalCalibrator({ windowSize: 100, minSamples: 30 });
    for (let i = 0; i < 100; i++) c.addScore(0.1);    // fills with low scores
    // Buffer is now full of 0.1s — pValue(1.0) should be tiny.
    const beforeFlood = c.pValue(1.0);
    // Flood with 1.0s — the 0.1s eviction begins.
    for (let i = 0; i < 100; i++) c.addScore(1.0);
    const afterFlood = c.pValue(1.0);
    // After flooding, the buffer is all 1.0s — p(1.0) should now be 1
    // (every calibration score equals the query).
    expect(beforeFlood).toBeLessThan(0.02);
    expect(afterFlood).toBeGreaterThan(0.95);
  });

  it('serialize → deserialize round-trips correctly', () => {
    const a = new ConformalCalibrator();
    for (let i = 0; i < 50; i++) a.addScore(i / 50);
    const snap = a.serialize();
    const b = ConformalCalibrator.deserialize(snap);
    expect(b.samples).toBe(a.samples);
    expect(b.pValue(0.5)).toBeCloseTo(a.pValue(0.5), 6);
  });

  it('quantile() returns ordered values', () => {
    const c = new ConformalCalibrator();
    for (let i = 0; i < 100; i++) c.addScore(i);
    expect(c.quantile(0.5)).toBeCloseTo(50, 0);
    expect(c.quantile(0.95)).toBeGreaterThan(c.quantile(0.5));
  });

  it('ignores NaN / Infinity', () => {
    const c = new ConformalCalibrator();
    for (let i = 0; i < 100; i++) c.addScore(i / 100);
    const before = c.samples;
    c.addScore(NaN);
    c.addScore(Infinity);
    expect(c.samples).toBe(before);
  });
});
