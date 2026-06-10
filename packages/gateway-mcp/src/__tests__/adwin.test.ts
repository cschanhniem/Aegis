import { Adwin } from '../services/adwin';

describe('ADWIN drift detector', () => {
  it('produces no drift on a stable Bernoulli stream', () => {
    // Mersenne-Twister-ish but deterministic — same seed yields the
    // same stream so flaky CI is impossible.
    let s = 12345;
    const rand = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const a = new Adwin();
    let drifts = 0;
    for (let i = 0; i < 1000; i++) {
      const r = a.update(rand() < 0.3 ? 1 : 0);
      if (r.drift) drifts++;
    }
    // delta = 0.002 → expect almost zero false positives.
    expect(drifts).toBeLessThanOrEqual(2);
    expect(a.width).toBeGreaterThan(0);
  });

  it('detects a sudden mean shift', () => {
    const a = new Adwin();
    // 400 samples at mean ≈ 0.2, then 400 at mean ≈ 0.8
    let drifts = 0;
    for (let i = 0; i < 400; i++) {
      const r = a.update(i % 5 === 0 ? 1 : 0);     // ~0.2
      if (r.drift) drifts++;
    }
    const widthBeforeShift = a.width;
    for (let i = 0; i < 400; i++) {
      const r = a.update(i % 5 === 0 ? 0 : 1);     // ~0.8
      if (r.drift) drifts++;
    }
    expect(drifts).toBeGreaterThanOrEqual(1);
    // Mean post-shift should approach 0.8 — i.e. the old "low" half
    // got dropped.
    expect(a.mean).toBeGreaterThan(0.55);
    // Width should be smaller after the cut (some of the old window dropped)
    expect(a.width).toBeLessThan(widthBeforeShift + 400);
  });

  it('does not declare drift on slow gradual change (within bound)', () => {
    // Linear ramp from 0.30 → 0.35 over 1000 samples. Trend is within
    // the Hoeffding bound for delta=0.002 — ADWIN should keep absorbing.
    const a = new Adwin({ delta: 0.002 });
    let drifts = 0;
    for (let i = 0; i < 1000; i++) {
      const p = 0.30 + 0.05 * (i / 1000);
      const r = a.update((i * 73) % 1000 / 1000 < p ? 1 : 0);
      if (r.drift) drifts++;
    }
    // At most a couple of false-alarm cuts; the stream is essentially stationary.
    expect(drifts).toBeLessThanOrEqual(3);
  });

  it('serialize → deserialize preserves window stats', () => {
    const a = new Adwin();
    for (let i = 0; i < 100; i++) a.update(Math.sin(i / 7));
    const snap = a.serialize();
    const b = Adwin.deserialize(snap);
    expect(b.width).toBe(a.width);
    expect(b.mean).toBeCloseTo(a.mean, 6);
    expect(b.variance).toBeCloseTo(a.variance, 6);
  });

  it('reset() empties the window', () => {
    const a = new Adwin();
    for (let i = 0; i < 100; i++) a.update(1);
    expect(a.width).toBeGreaterThan(0);
    a.reset();
    expect(a.width).toBe(0);
    expect(a.mean).toBe(0);
  });

  it('handles NaN / Infinity inputs gracefully', () => {
    const a = new Adwin();
    a.update(1); a.update(NaN); a.update(Infinity); a.update(2);
    expect(a.width).toBe(2);     // NaN/Inf were ignored
  });

  it('memory stays O(log W) — bucket count grows logarithmically', () => {
    const a = new Adwin({ maxRowBuckets: 5 });
    for (let i = 0; i < 10000; i++) a.update(0.4);   // stationary
    const snap = a.serialize();
    const totalBuckets = snap.rows.reduce((n, row) => n + row.length, 0);
    // log2(10000) ≈ 14, with M=5 buckets/row: bound ≈ 5 * 14 = 70.
    expect(totalBuckets).toBeLessThan(80);
  });
});
