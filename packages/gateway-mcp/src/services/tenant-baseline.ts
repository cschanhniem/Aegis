/**
 * Tenant baseline — aggregated feature stats across all agents in a
 * tenant. Cold-starts new agents by SEEDING their feature_stats /
 * Mahalanobis mean from this aggregate, so the detector produces
 * meaningful scores from call #1 instead of waiting 30 samples.
 *
 * Background: cold-start anomaly detection is an open research area
 * (Cold-Start AD arXiv 2405.20341, FiLo++ arXiv 2501.10067). The
 * pragmatic industry pattern: "if your tenant already has 20 agents,
 * the new agent's normal probably looks SIMILAR to the tenant's
 * average normal." That gets us 80% of the value with 1% of the
 * complexity of a foundation-model-based approach.
 *
 * Aggregation strategy:
 *
 *   - Mean: trimmed mean (drop top/bottom 5%) across per-agent means.
 *     Robust to a single misbehaving agent skewing the baseline.
 *
 *   - Variance: median across per-agent variances (also robust).
 *
 *   - Sample count: SUM (we want the baseline to "weigh" by how much
 *     data went into it — bigger tenants → more confident baseline).
 *
 * Refresh: lazy. Each `getBaseline(orgId)` call recomputes on the fly
 * from currently-persisted profiles (typically ≤ 50 agents per tenant
 * in production, so the aggregate is microseconds). Optional `refresh()`
 * forces a recompute and caches.
 *
 * Use sites:
 *
 *   1. AnomalyDetector.evaluate() — when a new agent has fewer than
 *      a threshold of samples, blend `profile.featureStats` toward the
 *      tenant baseline.
 *
 *   2. Cockpit "tenant overview" — show "your tenant's typical agent
 *      pattern" so operators can sanity-check.
 *
 *   3. Per-tool clustering (future): the same aggregate can be split
 *      per-tool to produce per-cluster baselines.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { FEATURE_DIM } from './feature-encoder';

export interface TenantBaseline {
  org_id: string;
  /** Per-feature trimmed mean across the tenant's agents. */
  mean: number[];
  /** Per-feature median variance across the tenant's agents. */
  variance: number[];
  /** Total samples backing this baseline (sum of agent n's). */
  total_samples: number;
  /** Number of agents that contributed. */
  agent_count: number;
  /** When this was computed. */
  computed_at: string;
}

export class TenantBaselineService {
  private cache = new Map<string, { baseline: TenantBaseline; cachedAt: number }>();
  /** Cache TTL — refresh at most once per minute under load. */
  private static TTL_MS = 60_000;

  constructor(private db: Database.Database, private logger: Logger) {}

  /** Get the current baseline. Lazy-computed + cached for TTL_MS. */
  getBaseline(orgId: string): TenantBaseline | null {
    const cached = this.cache.get(orgId);
    if (cached && Date.now() - cached.cachedAt < TenantBaselineService.TTL_MS) {
      return cached.baseline;
    }
    return this.refresh(orgId);
  }

  /** Force-recompute the baseline. Returns null when the tenant has
   *  no agents with feature_stats yet. */
  refresh(orgId: string): TenantBaseline | null {
    // agent_profiles has no org_id column; join with `agents` (registry)
    // to scope by tenant. Agents that don't have a registry row are
    // excluded — intentional, since we don't know their tenant.
    const rows = this.db.prepare(
      `SELECT ap.agent_id AS agent_id, ap.profile_json AS profile_blob
         FROM agent_profiles ap
         JOIN agents a ON a.id = ap.agent_id
        WHERE a.org_id = ?`,
    ).all(orgId) as Array<{ agent_id: string; profile_blob: string | null }> | undefined;
    if (!rows || rows.length === 0) return null;

    // Pull featureStats from each profile blob; require n >= 5 to
    // count (filter out cold-start agents that would otherwise pollute
    // the aggregate).
    const meansPerDim: number[][] = Array.from({ length: FEATURE_DIM }, () => []);
    const varsPerDim:  number[][] = Array.from({ length: FEATURE_DIM }, () => []);
    let totalSamples = 0;
    let contributors = 0;

    for (const r of rows) {
      if (!r.profile_blob) continue;
      let profile: any;
      try { profile = JSON.parse(r.profile_blob); }
      catch { continue; }
      const fs = profile?.featureStats;
      if (!fs || !Array.isArray(fs.mean) || !Array.isArray(fs.variance)) continue;
      if (typeof fs.n !== 'number' || fs.n < 5) continue;
      if (fs.mean.length !== FEATURE_DIM || fs.variance.length !== FEATURE_DIM) continue;

      contributors++;
      totalSamples += fs.n;
      for (let i = 0; i < FEATURE_DIM; i++) {
        meansPerDim[i].push(fs.mean[i]);
        varsPerDim[i].push(fs.variance[i]);
      }
    }

    if (contributors === 0) return null;

    const mean = meansPerDim.map(arr => trimmedMean(arr, 0.05));
    const variance = varsPerDim.map(arr => median(arr));

    const baseline: TenantBaseline = {
      org_id: orgId,
      mean,
      variance,
      total_samples: totalSamples,
      agent_count: contributors,
      computed_at: new Date().toISOString(),
    };
    this.cache.set(orgId, { baseline, cachedAt: Date.now() });
    return baseline;
  }

  /** Drop the cached baseline (used by tests + when an agent's profile
   *  is updated and we want a fresh aggregate). */
  invalidate(orgId?: string): void {
    if (orgId) this.cache.delete(orgId);
    else this.cache.clear();
  }
}

// ── robust statistics helpers ─────────────────────────────────────

/** Trimmed mean: drop the top and bottom `frac` of values, average the
 *  rest. Resistant to a few outlier-agents skewing the aggregate. */
function trimmedMean(values: number[], frac: number): number {
  if (values.length === 0) return 0;
  if (values.length < 4) return values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = values.slice().sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * frac);
  const trimmed = sorted.slice(drop, sorted.length - drop);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

/** Median: robust to extreme outliers (used for variance aggregation). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
