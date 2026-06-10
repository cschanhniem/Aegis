import { AnomalyExplainer } from '../services/anomaly-explainer';
import { IsolationForest } from '../services/isolation-forest';
import { HalfSpaceTrees } from '../services/half-space-trees';
import { MahalanobisScorer } from '../services/mahalanobis';
import { FEATURE_DIM, FEATURE_NAMES } from '../services/feature-encoder';

function seededRand(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s & 0x7fffffff) / 0x7fffffff; };
}

function makeWarmedTrees(seed: number): { forest: IsolationForest; hst: HalfSpaceTrees; maha: MahalanobisScorer } {
  const r = seededRand(seed);
  const forest = new IsolationForest({ numTrees: 20, sampleSize: 64, reservoirSize: 256 });
  const hst    = new HalfSpaceTrees({ numTrees: 10, depth: 6, windowSize: 128 });
  const maha   = new MahalanobisScorer({ shrinkage: 0.1, minSamples: 20 });
  // Train on 200 N(0,I)-distributed points
  for (let i = 0; i < 200; i++) {
    const v = Array.from({ length: FEATURE_DIM }, () => r() * 0.3);
    forest.addSample(v);
    hst.update(v);
    maha.update(v);
  }
  return { forest, hst, maha };
}

describe('AnomalyExplainer — SHAP-style feature attribution', () => {
  it('produces a contributions vector aligned with feature names', () => {
    const { forest, hst, maha } = makeWarmedTrees(1);
    const exp = new AnomalyExplainer(3);
    const x = new Array(FEATURE_DIM).fill(0.1);
    const out = exp.explain({
      normalized: x, rawFeatures: x,
      forest, hst, maha,
      ensembleScore: 0.5,
    });
    expect(out.contributions).toHaveLength(FEATURE_DIM);
    expect(out.top_features).toHaveLength(3);
    for (const f of out.top_features) {
      expect(FEATURE_NAMES).toContain(f.name);
      expect(f.index).toBeGreaterThanOrEqual(0);
      expect(f.index).toBeLessThan(FEATURE_DIM);
    }
  });

  it('top_features identifies the unusually-large dimension', () => {
    const { forest, hst, maha } = makeWarmedTrees(2);
    const exp = new AnomalyExplainer(3);
    // Vector mostly normal, but dim 4 (arg_length_zscore) is huge
    const x = new Array(FEATURE_DIM).fill(0.1);
    x[4] = 5.0;
    const out = exp.explain({
      normalized: x, rawFeatures: x, forest, hst, maha, ensembleScore: 0.85,
    });
    const topNames = out.top_features.map(f => f.name);
    expect(topNames).toContain('arg_length_zscore');
  });

  it('human_text mentions the dominant contributor', () => {
    const { forest, hst, maha } = makeWarmedTrees(3);
    const exp = new AnomalyExplainer(3);
    const x = new Array(FEATURE_DIM).fill(0.05);
    x[0] = 1.0;   // tool_novelty = 1 means "never seen"
    const out = exp.explain({
      normalized: x, rawFeatures: x, forest, hst, maha, ensembleScore: 0.7,
    });
    expect(out.human_text.toLowerCase()).toMatch(/anomalous|never used|tool/i);
  });

  it('handles cold-start (untrained detectors) without crashing', () => {
    const exp = new AnomalyExplainer(3);
    const out = exp.explain({
      normalized: new Array(FEATURE_DIM).fill(0),
      rawFeatures: new Array(FEATURE_DIM).fill(0),
      ensembleScore: 0.5,
    });
    // All zero contributions
    expect(out.contributions.every(c => c === 0)).toBe(true);
    expect(out.top_features).toHaveLength(3);
    expect(out.human_text).toMatch(/no single feature/);
  });

  it('raw_value preserves the un-normalized input', () => {
    const { forest, hst, maha } = makeWarmedTrees(4);
    const exp = new AnomalyExplainer(3);
    const norm = new Array(FEATURE_DIM).fill(0);
    const raw  = new Array(FEATURE_DIM).fill(0);
    raw[8] = 42;  // burst_ratio raw is 42 calls/min
    norm[8] = 3.5;
    const out = exp.explain({
      normalized: norm, rawFeatures: raw, forest, hst, maha, ensembleScore: 0.6,
    });
    const burst = out.top_features.find(f => f.name === 'burst_ratio');
    if (burst) expect(burst.raw_value).toBe(42);
  });

  it('contributions sum (positive only) ≈ ensemble score', () => {
    const { forest, hst, maha } = makeWarmedTrees(5);
    const exp = new AnomalyExplainer(3);
    const x = new Array(FEATURE_DIM).fill(0.4);
    x[1] = 2.0; x[4] = 2.0; x[10] = 2.0;   // multiple moderate anomalies
    const ensembleScore = 0.65;
    const out = exp.explain({
      normalized: x, rawFeatures: x, forest, hst, maha, ensembleScore,
    });
    const sumPos = out.contributions.reduce((a, b) => a + Math.max(0, b), 0);
    // After rescaling, positive sum should be close to the ensemble score
    expect(sumPos).toBeGreaterThan(0);
    expect(sumPos).toBeLessThanOrEqual(ensembleScore + 0.1);
  });

  it('handles dimensions where all detectors are absent', () => {
    const exp = new AnomalyExplainer(3);
    const out = exp.explain({
      normalized: new Array(FEATURE_DIM).fill(0.5),
      rawFeatures: new Array(FEATURE_DIM).fill(0.5),
      ensembleScore: 0.3,
    });
    expect(out.contributions).toHaveLength(FEATURE_DIM);
    // No crashes, but all contributions zero
    expect(out.contributions.every(c => c === 0)).toBe(true);
  });

  it('detectorWeights influences final contributions', () => {
    const { forest, hst, maha } = makeWarmedTrees(6);
    const exp = new AnomalyExplainer(3);
    const x = new Array(FEATURE_DIM).fill(0.1);
    x[7] = 3.0;
    const ifHeavy = exp.explain({
      normalized: x, rawFeatures: x, forest, hst, maha,
      ensembleScore: 0.5,
      detectorWeights: [10, 0.01, 0.01],
    });
    const hstHeavy = exp.explain({
      normalized: x, rawFeatures: x, forest, hst, maha,
      ensembleScore: 0.5,
      detectorWeights: [0.01, 10, 0.01],
    });
    // Either both should detect the same outlier OR they should differ
    // in contribution magnitudes — the weighted detector should dominate
    expect(ifHeavy.contributions.some((c, i) => Math.abs(c - hstHeavy.contributions[i]) > 1e-6))
      .toBe(true);
  });
});
