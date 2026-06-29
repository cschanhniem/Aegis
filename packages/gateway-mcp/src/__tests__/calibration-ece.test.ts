/**
 * Tests for the ECE / reliability-diagram math. We don't depend on a
 * judge here — these are pure-function tests covering the Guo et al.
 * 2017 binning estimator.
 */

import {
  calibrate,
  calibrateStratified,
  renderReliabilityAscii,
  type Prediction,
} from '../calibration/ece';

describe('calibrate()', () => {
  test('empty input returns zeroed result', () => {
    const r = calibrate([]);
    expect(r.n).toBe(0);
    expect(r.ece).toBe(0);
    expect(r.bins).toHaveLength(0);
  });

  test('perfectly calibrated input → ECE ≈ 0', () => {
    // 10 samples per bin, each bin's accuracy matches its confidence.
    // We hand-craft: bin 0.0-0.1 has 0% acc at 0.05 conf, ..., bin 0.9-1.0 has 95% acc at 0.95 conf.
    const preds: Prediction[] = [];
    for (let b = 0; b < 10; b++) {
      const conf = (b + 0.5) / 10;          // midpoint
      const acc  = (b + 0.5) / 10;          // matches conf
      const inBin = 20;
      const hits  = Math.round(acc * inBin);
      for (let i = 0; i < inBin; i++) {
        preds.push({
          predicted: 'A',
          confidence: conf,
          truth: i < hits ? 'A' : 'B',
        });
      }
    }
    const r = calibrate(preds, 10);
    expect(r.n).toBe(200);
    // Bin midpoints align exactly → ECE should be effectively zero
    expect(r.ece).toBeLessThan(0.001);
  });

  test('always-correct judge at 100% confidence → ECE = 0, accuracy = 1', () => {
    const preds: Prediction[] = Array.from({ length: 50 }, () => ({
      predicted: 'block', confidence: 1.0, truth: 'block',
    }));
    const r = calibrate(preds);
    expect(r.accuracy).toBe(1);
    expect(r.meanConfidence).toBe(1);
    expect(r.ece).toBe(0);
    expect(r.brier).toBe(0);
  });

  test('always-wrong judge at 100% confidence → ECE = 1', () => {
    const preds: Prediction[] = Array.from({ length: 50 }, () => ({
      predicted: 'allow', confidence: 1.0, truth: 'block',
    }));
    const r = calibrate(preds);
    expect(r.accuracy).toBe(0);
    expect(r.meanConfidence).toBe(1);
    expect(r.ece).toBeCloseTo(1, 6);
    expect(r.brier).toBeCloseTo(1, 6);
  });

  test('overconfident judge: 50% accuracy at 90% confidence → ECE ≈ 0.4', () => {
    const preds: Prediction[] = [];
    for (let i = 0; i < 100; i++) {
      preds.push({
        predicted: 'block',
        confidence: 0.9,
        truth: i < 50 ? 'block' : 'allow',
      });
    }
    const r = calibrate(preds);
    expect(r.accuracy).toBeCloseTo(0.5, 6);
    expect(r.meanConfidence).toBeCloseTo(0.9, 6);
    expect(r.ece).toBeCloseTo(0.4, 6);
  });

  test('confidence of 1.0 lands in the last bin (no off-by-one)', () => {
    const preds: Prediction[] = [
      { predicted: 'A', confidence: 1.0, truth: 'A' },
    ];
    const r = calibrate(preds, 10);
    expect(r.bins[9].count).toBe(1);
    expect(r.bins[0].count).toBe(0);
  });

  test('rejects non-numeric or out-of-range confidence', () => {
    expect(() => calibrate([{ predicted: 'A', confidence: NaN, truth: 'A' }])).toThrow(/non-numeric/);
    expect(() => calibrate([{ predicted: 'A', confidence: -0.1, truth: 'A' }])).toThrow(/out of/);
    expect(() => calibrate([{ predicted: 'A', confidence: 1.2,  truth: 'A' }])).toThrow(/out of/);
  });

  test('rejects nBins < 2 or non-integer', () => {
    expect(() => calibrate([{ predicted: 'A', confidence: 0.5, truth: 'A' }], 1)).toThrow(/nBins/);
    expect(() => calibrate([{ predicted: 'A', confidence: 0.5, truth: 'A' }], 3.5)).toThrow(/nBins/);
  });

  test('MCE = max gap across non-empty bins (empty bins ignored)', () => {
    // One bin gap = 0, another = 0.5
    const preds: Prediction[] = [
      // Bin [0.0-0.1) confidence 0.05, 100% accurate → gap 0.95
      { predicted: 'X', confidence: 0.05, truth: 'X' },
      { predicted: 'X', confidence: 0.05, truth: 'X' },
      // Bin [0.9-1.0] confidence 0.95, 100% accurate → gap 0.05
      { predicted: 'X', confidence: 0.95, truth: 'X' },
      { predicted: 'X', confidence: 0.95, truth: 'X' },
    ];
    const r = calibrate(preds, 10);
    expect(r.mce).toBeCloseTo(0.95, 6);
  });
});

describe('calibrateStratified()', () => {
  test('groups by extracted key and returns one result per group', () => {
    const preds = [
      { predicted: 'A', confidence: 0.9, truth: 'A', cat: 'normal' },
      { predicted: 'B', confidence: 0.9, truth: 'A', cat: 'jailbreak' },
      { predicted: 'A', confidence: 0.5, truth: 'A', cat: 'normal' },
    ];
    const by = calibrateStratified(preds, p => p.cat);
    expect(by.normal.n).toBe(2);
    expect(by.jailbreak.n).toBe(1);
    expect(by.normal.accuracy).toBe(1);
    expect(by.jailbreak.accuracy).toBe(0);
  });
});

describe('renderReliabilityAscii()', () => {
  test('produces one row per bin and includes count + values', () => {
    const r = calibrate([
      { predicted: 'A', confidence: 0.05, truth: 'A' },
      { predicted: 'A', confidence: 0.95, truth: 'B' },
    ], 10);
    const out = renderReliabilityAscii(r.bins);
    expect(out.split('\n')).toHaveLength(10);
    expect(out).toMatch(/n=1/);
    expect(out).toMatch(/conf/);
    expect(out).toMatch(/acc/);
  });
});
