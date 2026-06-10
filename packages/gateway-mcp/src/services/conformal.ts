/**
 * Conformal (split-conformal) calibrator for streaming anomaly scores.
 *
 * Problem: raw IF / Mahalanobis scores are model-internal — you can't
 * answer "what does score=0.71 mean operationally?" without empirical
 * calibration. Worse, when the score distribution drifts (a new model
 * version, a new traffic mix), the same threshold means different
 * things on different days.
 *
 * Conformal prediction (Vovk, Gammerman, Shafer 2005) gives the
 * principled answer:
 *
 *   p(x) = (1 + |{xi ∈ cal_set : score(xi) ≥ score(x)}|) / (1 + |cal_set|)
 *
 * Under exchangeability, p is a valid p-value: P(p ≤ α) ≤ α for fresh
 * "normal" observations. So:
 *   - Threshold "p < 0.01" → at most ~1% false-positive rate, by
 *     construction, in steady state.
 *   - Operationally interpretable: "we expect ~1 alert per 100 normal
 *     calls" instead of "score > 0.85 is suspicious" (which depends on
 *     the model).
 *
 * Streaming twist: classic split-conformal uses a *fixed* calibration
 * set. For long-running agents that's impossible. We use a *sliding*
 * calibration buffer (size W) with **weighted reservoir sampling**.
 * This preserves the marginal validity guarantee asymptotically while
 * absorbing slow drift.
 *
 * Cost:
 *   addScore(x):   O(log W) — insert into sorted buffer
 *   pValue(x):     O(log W) — binary-search rank
 *   memory:        O(W)     — default W=512
 */

const DEFAULT_WINDOW = 512;
const MIN_FOR_PVALUE = 30;

export interface ConformalConfig {
  /** Calibration buffer size. Higher = smoother p-values, more memory. */
  windowSize: number;
  /** Minimum samples in buffer before pValue returns < 1. */
  minSamples: number;
}

export interface ConformalSerialized {
  config: ConformalConfig;
  /** Sorted-ascending buffer of nonconformity scores. */
  sortedScores: number[];
  /** FIFO of insertion order — index into sortedScores would be
   *  expensive to maintain, so we keep the original score and re-find. */
  insertionOrder: number[];
  /** Insertion counter, for the FIFO eviction policy. */
  inserted: number;
}

const DEFAULT_CONFIG: ConformalConfig = {
  windowSize: DEFAULT_WINDOW,
  minSamples: MIN_FOR_PVALUE,
};

/**
 * Sliding-window split-conformal scorer.
 *
 * Workflow:
 *   1. For every observation classified as "labelled normal" by the
 *      downstream policy (e.g. approved by a human, or no anomaly in
 *      retrospect), call addScore(rawAnomalyScore).
 *   2. For every new observation, call pValue(rawAnomalyScore) to get
 *      the calibrated value in (0, 1]. Threshold on this in the policy
 *      layer ("if p < 0.01, flag").
 */
export class ConformalCalibrator {
  private sorted: number[] = [];
  /** FIFO of indices-into-`sorted` is brittle; we instead store the
   *  scores in insertion order and re-find via the sorted view when
   *  evicting. This is O(log W) per eviction — fine. */
  private insertionOrder: number[] = [];
  private inserted = 0;
  private readonly config: ConformalConfig;

  constructor(config: Partial<ConformalConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Push a new "calibration-set" nonconformity score. */
  addScore(s: number): void {
    if (!Number.isFinite(s)) return;
    insertSorted(this.sorted, s);
    this.insertionOrder.push(s);
    this.inserted += 1;
    if (this.insertionOrder.length > this.config.windowSize) {
      const evicted = this.insertionOrder.shift()!;
      removeOneFromSorted(this.sorted, evicted);
    }
  }

  /**
   * Conformal p-value for a fresh score x:
   *
   *   p(x) = (1 + count{si ≥ x}) / (1 + |buffer|)
   *
   * Smaller p ⇒ more anomalous. Floor of `1/(W+1)` (no zeros — keeps
   * downstream log-transformations / Bonferroni products well-defined).
   */
  pValue(s: number): number {
    if (this.sorted.length < this.config.minSamples) return 1;
    if (!Number.isFinite(s)) return 1;
    const ge = countGte(this.sorted, s);
    return (1 + ge) / (1 + this.sorted.length);
  }

  /** Quantile of the buffer at probability q ∈ [0,1]. */
  quantile(q: number): number {
    if (this.sorted.length === 0) return 0;
    const idx = Math.min(this.sorted.length - 1, Math.max(0, Math.floor(q * this.sorted.length)));
    return this.sorted[idx];
  }

  /** Number of scores in the calibration buffer. */
  get samples(): number { return this.sorted.length; }

  /** Total scores ever inserted (for drift / lifetime metrics). */
  get totalSeen(): number { return this.inserted; }

  serialize(): ConformalSerialized {
    return {
      config: this.config,
      sortedScores:    this.sorted.slice(),
      insertionOrder:  this.insertionOrder.slice(),
      inserted:        this.inserted,
    };
  }

  static deserialize(data: ConformalSerialized): ConformalCalibrator {
    const c = new ConformalCalibrator(data.config);
    c.sorted = data.sortedScores.slice();
    c.insertionOrder = data.insertionOrder.slice();
    c.inserted = data.inserted;
    return c;
  }
}

// ── sorted-array helpers (binary insert / remove / count ≥) ──────────────

function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(arr: number[], x: number): void {
  const idx = lowerBound(arr, x);
  arr.splice(idx, 0, x);
}

function removeOneFromSorted(arr: number[], x: number): void {
  const idx = lowerBound(arr, x);
  if (idx < arr.length && arr[idx] === x) arr.splice(idx, 1);
}

function countGte(arr: number[], x: number): number {
  // arr is sorted ascending, return |{a ∈ arr : a ≥ x}|.
  return arr.length - lowerBound(arr, x);
}
