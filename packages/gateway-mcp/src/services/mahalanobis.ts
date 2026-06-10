/**
 * Online Mahalanobis-distance scorer.
 *
 * Why this exists alongside Isolation Forest:
 *   - IF builds random axis-aligned splits → blind to anomalies that
 *     live in a *correlated* combination of features (the classic
 *     "diagonal" anomaly).
 *   - Mahalanobis distance accounts for the inverse covariance Σ⁻¹ —
 *     small d² = vector lies on the data's "principal axes," large d²
 *     = vector breaks the correlation pattern even though no single
 *     feature looks unusual.
 *
 * Implementation: streaming Welford for the mean, a regularised
 * shrinkage estimator (Ledoit-Wolf style with a fixed shrinkage to
 * the identity) for the covariance. Shrinkage solves three things:
 *   1. Σ stays positive-definite even when n < d (early agent life).
 *   2. Tiny variance dimensions don't blow up the inverse.
 *   3. We avoid storing & inverting Σ from a full data matrix — we
 *      keep Σ as a running scatter matrix and invert lazily.
 *
 * Cost:
 *   update():  O(d²)  — outer product on each call (d=16 → 256 ops)
 *   score():   O(d² + d³)  — invert + quadratic form. d=16 ≈ 4 K ops.
 *
 * For the AEGIS hot-path (d=16) both are sub-microsecond.
 */

/** Snapshot suitable for JSON-persistence. */
export interface MahalanobisSerialized {
  dims: number;
  n: number;
  mean: number[];
  /** Lower-triangular row-major scatter matrix (d*(d+1)/2 entries). */
  scatterLower: number[];
  shrinkage: number;
}

export interface MahalanobisConfig {
  /** Fixed shrinkage λ ∈ [0,1]. Final cov = (1-λ)·sample + λ·diag(μ_var)·I. */
  shrinkage: number;
  /** Minimum samples before score() returns a non-zero distance. */
  minSamples: number;
}

const DEFAULT_CONFIG: MahalanobisConfig = {
  shrinkage: 0.10,
  minSamples: 20,
};

export class MahalanobisScorer {
  private dims = 0;
  private n = 0;
  private mean: number[] = [];
  /** Sum of outer products of (x_i - mean_{i-1}) deviations — Welford form. */
  private M2: number[][] = [];
  private config: MahalanobisConfig;

  constructor(config: Partial<MahalanobisConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Incorporate one new observation. O(d²). */
  update(x: number[]): void {
    if (this.dims === 0) this.dims = x.length;
    if (x.length !== this.dims) return;
    this.n += 1;

    if (this.M2.length === 0) {
      this.mean = x.slice();
      this.M2 = Array.from({ length: this.dims }, () => new Array(this.dims).fill(0));
      return;
    }

    // Welford update for mean + scatter matrix.
    const delta = new Array(this.dims);
    for (let i = 0; i < this.dims; i++) delta[i] = x[i] - this.mean[i];
    for (let i = 0; i < this.dims; i++) this.mean[i] += delta[i] / this.n;
    const delta2 = new Array(this.dims);
    for (let i = 0; i < this.dims; i++) delta2[i] = x[i] - this.mean[i];
    // Outer product (symmetric — fill upper, mirror to lower).
    for (let i = 0; i < this.dims; i++) {
      for (let j = i; j < this.dims; j++) {
        const v = delta[i] * delta2[j];
        this.M2[i][j] += v;
        if (i !== j) this.M2[j][i] = this.M2[i][j];
      }
    }
  }

  /** Squared Mahalanobis distance d²(x). 0 when undertrained. */
  score(x: number[]): number {
    if (this.n < this.config.minSamples) return 0;
    if (this.dims === 0 || x.length !== this.dims) return 0;

    // Sample covariance Σ = M2 / (n-1)
    const sampleCov = this.scaledCov();
    const shrunk = this.shrink(sampleCov, this.config.shrinkage);
    const inv = invertSymmetric(shrunk);
    if (!inv) return 0;
    return this.quadratic(x, this.mean, inv);
  }

  /**
   * Tail probability under chi-square(d): P(D² > observed).
   * Returns a value in (0,1], where small = highly anomalous.
   * Wilson-Hilferty cubic-root approximation; closed form, no
   * dependencies. Accurate to within ~5% across the body of the dist.
   */
  pValue(score: number, dof?: number): number {
    const k = dof ?? this.dims;
    if (k <= 0 || score <= 0) return 1;
    const x = (Math.pow(score / k, 1 / 3) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
    return clamp01(1 - normalCdf(x));
  }

  get samples(): number { return this.n; }
  get featureDim(): number { return this.dims; }

  serialize(): MahalanobisSerialized {
    const lower: number[] = [];
    for (let i = 0; i < this.dims; i++) {
      for (let j = 0; j <= i; j++) lower.push(this.M2[i][j]);
    }
    return {
      dims: this.dims,
      n: this.n,
      mean: this.mean.slice(),
      scatterLower: lower,
      shrinkage: this.config.shrinkage,
    };
  }

  static deserialize(data: MahalanobisSerialized): MahalanobisScorer {
    const s = new MahalanobisScorer({ shrinkage: data.shrinkage });
    s.dims = data.dims;
    s.n = data.n;
    s.mean = data.mean.slice();
    s.M2 = Array.from({ length: data.dims }, () => new Array(data.dims).fill(0));
    let p = 0;
    for (let i = 0; i < data.dims; i++) {
      for (let j = 0; j <= i; j++) {
        const v = data.scatterLower[p++];
        s.M2[i][j] = v;
        s.M2[j][i] = v;
      }
    }
    return s;
  }

  private scaledCov(): number[][] {
    const denom = Math.max(this.n - 1, 1);
    const cov: number[][] = Array.from({ length: this.dims }, () => new Array(this.dims).fill(0));
    for (let i = 0; i < this.dims; i++)
      for (let j = 0; j < this.dims; j++)
        cov[i][j] = this.M2[i][j] / denom;
    return cov;
  }

  /** Σ' = (1-λ)·Σ + λ·diag(trace(Σ)/d)·I  — Ledoit-Wolf style with the
   *  shrinkage target being a scaled identity (the simplest target;
   *  Touloumis 2015 §3 calls this the "scalar" target). */
  private shrink(cov: number[][], lambda: number): number[][] {
    if (lambda <= 0) return cov;
    let trace = 0;
    for (let i = 0; i < this.dims; i++) trace += cov[i][i];
    const t = trace / Math.max(this.dims, 1);
    const out: number[][] = [];
    for (let i = 0; i < this.dims; i++) {
      out.push([]);
      for (let j = 0; j < this.dims; j++) {
        const target = i === j ? t : 0;
        out[i][j] = (1 - lambda) * cov[i][j] + lambda * target;
      }
    }
    return out;
  }

  private quadratic(x: number[], mu: number[], invCov: number[][]): number {
    const d = new Array(this.dims);
    for (let i = 0; i < this.dims; i++) d[i] = x[i] - mu[i];
    let total = 0;
    for (let i = 0; i < this.dims; i++) {
      let row = 0;
      for (let j = 0; j < this.dims; j++) row += invCov[i][j] * d[j];
      total += d[i] * row;
    }
    return Math.max(0, total);
  }
}

// ── linear-algebra helpers (kept here to avoid pulling in numeric.js) ──

/** Invert a symmetric positive-definite matrix via Cholesky.
 *  Returns null when the matrix is singular / non-PD. */
function invertSymmetric(mat: number[][]): number[][] | null {
  const n = mat.length;
  // Cholesky: mat = L · L^T
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const d = mat[i][i] - sum;
        if (d <= 1e-12) return null;
        L[i][j] = Math.sqrt(d);
      } else {
        L[i][j] = (mat[i][j] - sum) / L[j][j];
      }
    }
  }

  // Invert L (lower-triangular)
  const invL: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) invL[i][i] = 1 / L[i][i];
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum += L[i][k] * invL[k][j];
      invL[i][j] = -sum / L[i][i];
    }
  }

  // inv(mat) = invL^T · invL
  const inv: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = Math.max(i, j); k < n; k++) sum += invL[k][i] * invL[k][j];
      inv[i][j] = sum;
    }
  }
  return inv;
}

/** Standard normal CDF, Abramowitz & Stegun 26.2.17. */
function normalCdf(x: number): number {
  const a1 = 0.319381530;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2) *
    (a1 * k + a2 * k * k + a3 * k ** 3 + a4 * k ** 4 + a5 * k ** 5);
  return x >= 0 ? w : 1 - w;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 1;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
