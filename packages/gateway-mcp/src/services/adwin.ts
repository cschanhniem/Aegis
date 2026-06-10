/**
 * ADWIN — Adaptive Windowing for online concept-drift detection
 *
 * Reference: Bifet & Gavaldà, "Learning from time-changing data with
 * adaptive windowing" (SDM 2007).
 *
 * Purpose: distinguish "the agent's normal behaviour has shifted" from
 * "this individual call is anomalous." Without this, the EWMA + IF
 * baseline silently absorbs drift, so anomalies start to look normal
 * (false negatives) OR every call looks anomalous post-shift (false
 * positive storm). ADWIN keeps a window of recent observations and
 * tests whether any cut point splits the window into two halves with
 * statistically different means.
 *
 * Algorithm:
 *   W = sliding window of recent values
 *   For each new x_t:
 *     append x_t to W
 *     repeat
 *       for each split W = W0 + W1
 *         if |mean(W0) - mean(W1)| > epsilon_cut(W0, W1, delta):
 *           drop W0, emit DRIFT, recurse
 *
 *   epsilon_cut uses Hoeffding bound + Bonferroni correction:
 *     m = harmonic mean of |W0|, |W1|
 *     epsilon = sqrt( (1/(2m)) * ln(4|W|/delta) )
 *
 * Complexity per insertion: amortised O(log W).
 *
 * Properties: false-positive rate bounded by `delta`; detects drift
 * with high probability when the magnitude exceeds the bound.
 *
 * This implementation uses **exponential buckets** to keep memory
 * O(log W) instead of O(W). Each bucket stores (count, sum, sumSq).
 * Bucket capacity doubles per row; M (max buckets per row) bounds the
 * total bucket count.
 */

const DEFAULT_DELTA = 0.002;       // confidence parameter (p < 0.002 false-positive cut)
const DEFAULT_MAX_ROW_BUCKETS = 5; // bigger = tighter bound, more memory
const MIN_WINDOW_FOR_CUT = 30;     // don't even attempt a cut until we have this many samples

/** A bucket holds `capacity` items, summarised by their sum + sumSq. */
interface Bucket {
  /** Number of underlying items aggregated into this bucket */
  count: number;
  sum: number;
  sumSq: number;
}

/** A row is a list of buckets, all of the same capacity (2^rowIndex). */
type Row = Bucket[];

export interface AdwinConfig {
  /** False-positive rate bound. Default 0.002 (≈ 0.2%). */
  delta: number;
  /** Cap on buckets per row. M=5 is the value Bifet/Gavaldà used. */
  maxRowBuckets: number;
  /** Minimum window size before we attempt drift cuts. */
  minWindow: number;
}

const DEFAULT_CONFIG: AdwinConfig = {
  delta: DEFAULT_DELTA,
  maxRowBuckets: DEFAULT_MAX_ROW_BUCKETS,
  minWindow: MIN_WINDOW_FOR_CUT,
};

export interface AdwinUpdateResult {
  /** True iff this insertion triggered a drift cut. */
  drift: boolean;
  /** Number of items dropped from the head of the window (= old-window size). */
  dropped: number;
  /** Mean of the window AFTER the update. */
  mean: number;
  /** Total items currently in the window. */
  width: number;
  /** Estimated cut magnitude (|mean(W0) − mean(W1)|) at the drift point. */
  cutMagnitude?: number;
}

export interface AdwinSerialized {
  config: AdwinConfig;
  rows: Row[];
}

/**
 * ADWIN drift detector for a single numeric stream.
 *
 * Use one instance per agent, per metric you want to watch:
 *   - anomaly composite score   → detects "the agent is becoming anomalous"
 *   - per-tool frequency        → detects "this tool's usage shifted"
 *   - PPM surprise              → detects "sequence pattern shifted"
 *
 * Typical wiring: feed each new composite_score into update(), and on
 * `drift: true` (a) audit-log the event, (b) optionally reset the
 * downstream EWMA / feature-stats so the new baseline learns fresh.
 */
export class Adwin {
  private rows: Row[] = [];
  private readonly config: AdwinConfig;
  private cachedWidth = 0;
  private cachedSum = 0;
  private cachedSumSq = 0;

  constructor(config: Partial<AdwinConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Push a new value and check for drift.
   *
   * Returns { drift, dropped, mean, width }. When `drift: true`, the
   * window has been truncated to its newer half (everything before the
   * detected change-point has been dropped).
   */
  update(x: number): AdwinUpdateResult {
    if (!Number.isFinite(x)) {
      return { drift: false, dropped: 0, mean: this.mean, width: this.cachedWidth };
    }

    // Insert as a singleton bucket in row 0
    this.insertBucket(0, { count: 1, sum: x, sumSq: x * x });

    let dropped = 0;
    let cutMagnitude: number | undefined;

    if (this.cachedWidth >= this.config.minWindow) {
      // Repeatedly find a cut, drop the head, re-check.
      while (true) {
        const cut = this.findCut();
        if (!cut) break;
        dropped += cut.droppedCount;
        cutMagnitude = cut.magnitude;
        this.dropHead(cut.droppedCount, cut.droppedSum, cut.droppedSumSq);
      }
    }

    return {
      drift: dropped > 0,
      dropped,
      mean: this.mean,
      width: this.cachedWidth,
      cutMagnitude,
    };
  }

  /** Current window size. */
  get width(): number { return this.cachedWidth; }

  /** Current window mean. */
  get mean(): number {
    return this.cachedWidth > 0 ? this.cachedSum / this.cachedWidth : 0;
  }

  /** Current window variance (population). */
  get variance(): number {
    if (this.cachedWidth === 0) return 0;
    const m = this.mean;
    return Math.max(0, this.cachedSumSq / this.cachedWidth - m * m);
  }

  /** Reset to an empty window (e.g. after a confirmed drift event when
   *  the caller wants to wipe the state rather than keep the post-drift tail). */
  reset(): void {
    this.rows = [];
    this.cachedWidth = 0;
    this.cachedSum = 0;
    this.cachedSumSq = 0;
  }

  serialize(): AdwinSerialized {
    return { config: this.config, rows: this.rows.map(r => r.slice()) };
  }

  static deserialize(data: AdwinSerialized): Adwin {
    const a = new Adwin(data.config);
    a.rows = data.rows.map(r => r.slice());
    a.recomputeCached();
    return a;
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private insertBucket(rowIdx: number, bucket: Bucket): void {
    while (this.rows.length <= rowIdx) this.rows.push([]);
    this.rows[rowIdx].push(bucket);
    this.cachedWidth += bucket.count;
    this.cachedSum   += bucket.sum;
    this.cachedSumSq += bucket.sumSq;

    // Cascade: if this row exceeds M buckets, merge the two oldest into
    // the next row up (capacity doubles per row).
    if (this.rows[rowIdx].length > this.config.maxRowBuckets) {
      const a = this.rows[rowIdx].shift()!;
      const b = this.rows[rowIdx].shift()!;
      const merged: Bucket = {
        count: a.count + b.count,
        sum:   a.sum   + b.sum,
        sumSq: a.sumSq + b.sumSq,
      };
      // Recurse — note we don't update cached counters; the bucket
      // already counted in cached* moves to a higher row but its data
      // stays in the window, so cached* is still correct.
      this.cascadeInsert(rowIdx + 1, merged);
    }
  }

  private cascadeInsert(rowIdx: number, bucket: Bucket): void {
    while (this.rows.length <= rowIdx) this.rows.push([]);
    this.rows[rowIdx].push(bucket);
    if (this.rows[rowIdx].length > this.config.maxRowBuckets) {
      const a = this.rows[rowIdx].shift()!;
      const b = this.rows[rowIdx].shift()!;
      this.cascadeInsert(rowIdx + 1, {
        count: a.count + b.count,
        sum:   a.sum   + b.sum,
        sumSq: a.sumSq + b.sumSq,
      });
    }
  }

  /**
   * Try every cut point W = W0 + W1 (from oldest buckets onward).
   * Return the first cut where the bound is exceeded — i.e. drop
   * everything up to and including W0.
   *
   * W0 grows by one bucket at a time; we iterate oldest → newest.
   * Cuts on bucket boundaries only — that's the ADWIN-2 simplification
   * that brings the per-insertion cost down to O(log W) while keeping
   * the same false-positive bound (with a slightly looser power).
   */
  private findCut(): { droppedCount: number; droppedSum: number; droppedSumSq: number; magnitude: number } | null {
    // Linearize buckets: oldest row, oldest bucket first.
    // Working from the *highest* row index downward gives us the oldest
    // buckets first (since cascades push old data to higher rows).
    const ordered: { row: number; idx: number; bucket: Bucket }[] = [];
    for (let r = this.rows.length - 1; r >= 0; r--) {
      const row = this.rows[r];
      for (let i = 0; i < row.length; i++) {
        ordered.push({ row: r, idx: i, bucket: row[i] });
      }
    }

    let n0 = 0, s0 = 0, ss0 = 0;
    let n1 = this.cachedWidth, s1 = this.cachedSum, ss1 = this.cachedSumSq;

    for (let i = 0; i < ordered.length - 1; i++) {
      const b = ordered[i].bucket;
      n0 += b.count; s0 += b.sum; ss0 += b.sumSq;
      n1 -= b.count; s1 -= b.sum; ss1 -= b.sumSq;

      if (n0 < 1 || n1 < 1) continue;
      const mean0 = s0 / n0;
      const mean1 = s1 / n1;
      const magnitude = Math.abs(mean0 - mean1);
      const epsilon = this.epsilonCut(n0, n1);
      if (magnitude > epsilon) {
        return { droppedCount: n0, droppedSum: s0, droppedSumSq: ss0, magnitude };
      }
    }
    return null;
  }

  /**
   * Hoeffding-based cut bound. Tight enough that the per-cut
   * false-positive rate is ≤ delta/(W*log W) — multiplying out, the
   * window-wide rate stays ≤ delta. Bifet/Gavaldà Theorem 3.1.
   *
   * For variance-aware sub-Gaussian bound we'd use the Bernstein form
   * with sample variance; staying with Hoeffding for robustness against
   * non-iid streams.
   */
  private epsilonCut(n0: number, n1: number): number {
    const m = 1 / (1 / n0 + 1 / n1);   // harmonic mean
    const deltaPrime = this.config.delta / Math.max(this.cachedWidth, 1);
    return Math.sqrt((1 / (2 * m)) * Math.log(4 / deltaPrime));
  }

  private dropHead(count: number, sum: number, sumSq: number): void {
    // Pop buckets starting from the highest row (oldest data) until
    // we've removed `count` items.
    let remaining = count;
    for (let r = this.rows.length - 1; r >= 0 && remaining > 0; r--) {
      const row = this.rows[r];
      while (row.length > 0 && remaining > 0) {
        const b = row[0];
        if (b.count > remaining) {
          // Partial bucket — split. Buckets only store aggregates, so we
          // approximate by leaving the rest as a smaller bucket with
          // proportionally-scaled sum/sumSq. Acceptable: ADWIN-2 only
          // cuts on bucket boundaries; this branch is hit when the
          // requested drop straddles one. Stays correct in expectation.
          const frac = (b.count - remaining) / b.count;
          row[0] = {
            count: b.count - remaining,
            sum:   b.sum   * frac,
            sumSq: b.sumSq * frac,
          };
          remaining = 0;
        } else {
          row.shift();
          remaining -= b.count;
        }
      }
    }
    this.cachedWidth -= count;
    this.cachedSum   -= sum;
    this.cachedSumSq -= sumSq;
    if (this.cachedWidth < 0) this.cachedWidth = 0;
  }

  private recomputeCached(): void {
    let w = 0, s = 0, ss = 0;
    for (const row of this.rows) {
      for (const b of row) {
        w += b.count; s += b.sum; ss += b.sumSq;
      }
    }
    this.cachedWidth = w; this.cachedSum = s; this.cachedSumSq = ss;
  }
}
