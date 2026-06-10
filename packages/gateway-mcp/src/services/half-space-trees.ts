/**
 * Streaming Half-Space Trees (HST) — Tan, Ting & Liu, IJCAI 2011.
 *
 * Why this exists alongside Isolation Forest:
 *
 *   - IF needs a reservoir of historical points + periodic re-train.
 *     That's fine, but on a fast-drifting stream the reservoir lags
 *     and the trees stay stale.
 *
 *   - HST is purpose-built for streams: trees are random *partitions
 *     of the feature space*, not data-driven splits. Each leaf
 *     maintains a mass counter that's updated in O(1) per point.
 *     "Anomalous" = "ends up in low-mass leaves on most trees."
 *
 *   - Memory is bounded: a HST of depth h on d dims has 2^h leaves.
 *     Default h=8 → 256 leaves * sizeof(int) per tree, well under 4KB
 *     per tree. River (the Python streaming-ML library) uses HST as
 *     its default isolation method for exactly this reason.
 *
 * Two-window scheme (Tan et al. §2.2):
 *
 *   reference  — the previous "window worth" of points, frozen
 *   latest     — the window we're currently filling
 *
 * Scores are computed against the *reference* window (so the score
 * doesn't trivially become 1 for fresh points). When `latest` fills,
 * it swaps in to become `reference`; a fresh empty `latest` begins.
 * This gives HST its natural drift-handling: yesterday's normal stays
 * the score baseline for today, but slowly rolls forward.
 *
 * Score formula (Tan §3, eqn 4):
 *
 *   s(x) = Σ_t  refMass(leaf_t(x)) * 2^(depth(leaf_t(x)))
 *
 * Anomalies fall into low-reference-mass leaves at shallow depth →
 * low score. Normal points fall into high-mass leaves → high score.
 * We invert and normalize to [0,1] with HIGHER = MORE ANOMALOUS so
 * the AEGIS contract matches IF / Mahalanobis.
 *
 * Cost:
 *   update():  O(t · h)  ≈ 25 trees · 8 depth = 200 ops per point
 *   score():   O(t · h)  same
 *   memory:    O(t · 2^h · 2) — two windows of mass counters per tree
 */

const DEFAULT_NUM_TREES   = 25;
const DEFAULT_DEPTH       = 8;
const DEFAULT_WINDOW_SIZE = 256;
const DEFAULT_MIN_MASS    = 1;
const DEFAULT_MIN_SAMPLES = 30;

export interface HstConfig {
  numTrees: number;
  depth: number;
  windowSize: number;
  /** Smallest mass we credit a leaf with — protects log/score from 0. */
  minMass: number;
  /** Don't return a meaningful score until we've seen at least this many points. */
  minSamples: number;
}

const DEFAULT_CONFIG: HstConfig = {
  numTrees:   DEFAULT_NUM_TREES,
  depth:      DEFAULT_DEPTH,
  windowSize: DEFAULT_WINDOW_SIZE,
  minMass:    DEFAULT_MIN_MASS,
  minSamples: DEFAULT_MIN_SAMPLES,
};

/** Per-tree state. Each tree is a *random* axis-aligned partition of
 *  the feature space — no data-driven splits. We pre-pick (dim, mid)
 *  pairs at tree-creation time and reuse them forever. */
interface Tree {
  /** One split per internal-node level: dim[depth], mid[depth].
   *  Total 2^h leaves. */
  dims: number[];
  mids: number[];
  /** refMass[leafIdx] = #points from the FROZEN reference window in leaf */
  refMass: number[];
  /** latMass[leafIdx] = #points from the CURRENT latest window in leaf */
  latMass: number[];
}

export interface HstSerialized {
  config: HstConfig;
  dims: number;
  ranges: { min: number; max: number }[];
  trees: { dims: number[]; mids: number[]; refMass: number[]; latMass: number[] }[];
  count: number;        // total samples seen
  windowCount: number;  // samples in current `latest` window
  warmed: boolean;
}

export class HalfSpaceTrees {
  private cfg: HstConfig;
  private dims = 0;
  /** Per-dim min/max seen — feeds tree-split midpoints. */
  private ranges: { min: number; max: number }[] = [];
  private trees: Tree[] = [];
  private count = 0;
  private windowCount = 0;
  /** Once true, refMass holds a real reference window and scores are usable. */
  private warmed = false;

  constructor(config: Partial<HstConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  /** Incorporate a new point. O(t · h). Triggers the window roll
   *  when we've accumulated `windowSize` points in `latest`. */
  update(x: number[]): void {
    if (!Number.isFinite(x[0])) return;
    if (this.dims === 0) {
      this.dims = x.length;
      this.bootstrap(x);
    } else if (x.length !== this.dims) {
      return;   // dim mismatch — silently skip
    } else {
      // Extend per-dim ranges so we can build new trees later if the
      // distribution shifts dramatically.
      for (let i = 0; i < this.dims; i++) {
        if (x[i] < this.ranges[i].min) this.ranges[i].min = x[i];
        if (x[i] > this.ranges[i].max) this.ranges[i].max = x[i];
      }
    }

    for (const t of this.trees) {
      const leaf = this.findLeaf(t, x);
      t.latMass[leaf]++;
    }
    this.count++;
    this.windowCount++;

    if (this.windowCount >= this.cfg.windowSize) {
      this.rollWindow();
    }
  }

  /** Returns anomaly score ∈ [0, 1]; higher = more anomalous.
   *  Returns 0 before the first window has rolled (cold-start). */
  score(x: number[]): number {
    if (!this.warmed || this.dims === 0 || x.length !== this.dims) return 0;
    if (this.count < this.cfg.minSamples) return 0;

    let totalMass = 0;
    let maxPossibleMass = 0;
    for (const t of this.trees) {
      const leaf = this.findLeaf(t, x);
      const depth = this.leafDepth();
      const m = Math.max(t.refMass[leaf], this.cfg.minMass);
      const mScaled = m * Math.pow(2, depth);
      totalMass += mScaled;
      maxPossibleMass += this.cfg.windowSize * Math.pow(2, depth);
    }
    // Normalize and invert: high refMass ⇒ normal ⇒ score → 0;
    // low refMass ⇒ anomalous ⇒ score → 1.
    const normalRatio = maxPossibleMass > 0 ? totalMass / maxPossibleMass : 0;
    return Math.max(0, Math.min(1, 1 - normalRatio));
  }

  /** Convenience: combined update + score in one call. */
  scoreAndUpdate(x: number[]): number {
    const s = this.score(x);
    this.update(x);
    return s;
  }

  get isWarmed(): boolean { return this.warmed; }
  get samples(): number   { return this.count; }
  get featureDim(): number { return this.dims; }

  serialize(): HstSerialized {
    return {
      config: this.cfg,
      dims: this.dims,
      ranges: this.ranges.map(r => ({ ...r })),
      trees: this.trees.map(t => ({
        dims: t.dims.slice(),
        mids: t.mids.slice(),
        refMass: t.refMass.slice(),
        latMass: t.latMass.slice(),
      })),
      count: this.count,
      windowCount: this.windowCount,
      warmed: this.warmed,
    };
  }

  static deserialize(s: HstSerialized): HalfSpaceTrees {
    const h = new HalfSpaceTrees(s.config);
    h.dims        = s.dims;
    h.ranges      = s.ranges.map(r => ({ ...r }));
    h.trees       = s.trees.map(t => ({
      dims: t.dims.slice(), mids: t.mids.slice(),
      refMass: t.refMass.slice(), latMass: t.latMass.slice(),
    }));
    h.count       = s.count;
    h.windowCount = s.windowCount;
    h.warmed      = s.warmed;
    return h;
  }

  // ── internal ───────────────────────────────────────────────────────

  /** Build `numTrees` random axis-aligned partition trees on first
   *  observation. Each tree gets a path of h random (dim, midpoint)
   *  splits — pre-picked, immutable. */
  private bootstrap(x: number[]): void {
    this.ranges = new Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      this.ranges[i] = { min: x[i] - 1, max: x[i] + 1 };   // seeded; updates() expand
    }
    this.trees = [];
    const numLeaves = 1 << this.cfg.depth;
    for (let t = 0; t < this.cfg.numTrees; t++) {
      const dims: number[] = new Array(this.cfg.depth);
      const mids: number[] = new Array(this.cfg.depth);
      for (let d = 0; d < this.cfg.depth; d++) {
        const dim = Math.floor(Math.random() * this.dims);
        dims[d] = dim;
        // Midpoint chosen uniformly within the current range estimate
        const r = this.ranges[dim];
        mids[d] = r.min + Math.random() * Math.max(r.max - r.min, 1e-9);
      }
      this.trees.push({
        dims, mids,
        refMass: new Array(numLeaves).fill(0),
        latMass: new Array(numLeaves).fill(0),
      });
    }
  }

  /** Roll the window: latMass → refMass; latMass reset to zero.
   *  This is how HST "ages out" yesterday's normal and learns today's. */
  private rollWindow(): void {
    for (const t of this.trees) {
      t.refMass = t.latMass;
      t.latMass = new Array(t.refMass.length).fill(0);
    }
    this.warmed = true;
    this.windowCount = 0;
  }

  /** Walk a tree from root to leaf. Leaves are indexed by treating the
   *  depth-h sequence of branch decisions as bits of the leaf index. */
  private findLeaf(t: Tree, x: number[]): number {
    let idx = 0;
    for (let d = 0; d < this.cfg.depth; d++) {
      idx <<= 1;
      if (x[t.dims[d]] > t.mids[d]) idx |= 1;
    }
    return idx;
  }

  private leafDepth(): number {
    return this.cfg.depth;
  }
}
