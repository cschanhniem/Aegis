/**
 * Per-compensator rollback metrics, Prometheus-flavored.
 *
 * Tracks for each tool_name × compensator_kind tuple:
 *   - total attempts
 *   - total successes
 *   - total failures
 *   - total skipped (irreversible / no compensator)
 *   - p50 / p95 / p99 latency
 *
 * All counters live in-memory (per-process). On restart they reset —
 * the Merkle audit log is the durable record; this layer is for
 * dashboards. For multi-replica or longer windows the operator should
 * scrape /metrics into Prometheus and query there.
 *
 * Latency is tracked via a t-digest-style approximation: bucketed
 * histogram (50 logarithmic buckets covering 1ms–60s). That gives us
 * O(1) update + O(buckets) quantile estimate with bounded memory per
 * tool × kind pair — no unbounded growth even for high-cardinality
 * tenants.
 *
 * Exposes:
 *   record(toolName, kind, outcome, durationMs) — increment counters
 *   snapshot() — return the current metric set
 *   prometheus() — render as text exposition format
 *
 * Output is Prometheus-compatible so a customer can `curl /metrics`
 * straight into their existing scraper.
 */

export type RollbackOutcome = 'rolled_back' | 'failed' | 'unsupported' | 'no_op';

interface ToolKindStats {
  /** Per-outcome counters. */
  total: Record<RollbackOutcome, number>;
  /** Latency histogram: bucket index → count. */
  hist: number[];
  /** Cumulative sum + count for mean. */
  sum_ms: number;
  count: number;
}

/** Logarithmic-edge bucket boundaries, 1ms to 60_000ms in ~30 buckets. */
const BUCKET_EDGES_MS = (() => {
  const out: number[] = [];
  // 50 log-spaced edges from 1 to 60000
  for (let i = 0; i < 50; i++) {
    const v = Math.exp(Math.log(1) + (i / 49) * (Math.log(60000) - Math.log(1)));
    out.push(v);
  }
  return out;
})();
const NUM_BUCKETS = BUCKET_EDGES_MS.length + 1;

function bucketOf(ms: number): number {
  if (ms <= 0) return 0;
  // Binary-search for the first edge ≥ ms.
  let lo = 0, hi = BUCKET_EDGES_MS.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (BUCKET_EDGES_MS[m] < ms) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function newStats(): ToolKindStats {
  return {
    total: { rolled_back: 0, failed: 0, unsupported: 0, no_op: 0 },
    hist: new Array(NUM_BUCKETS).fill(0),
    sum_ms: 0,
    count: 0,
  };
}

export class RollbackMetricsService {
  private byKey: Map<string, ToolKindStats> = new Map();

  /** Increment counters for a finished rollback step. */
  record(opts: {
    tool_name: string;
    compensator_kind: string;
    outcome: RollbackOutcome;
    duration_ms: number;
  }): void {
    const key = `${opts.tool_name}::${opts.compensator_kind}`;
    let s = this.byKey.get(key);
    if (!s) { s = newStats(); this.byKey.set(key, s); }
    s.total[opts.outcome]++;
    if (Number.isFinite(opts.duration_ms) && opts.duration_ms >= 0) {
      s.hist[bucketOf(opts.duration_ms)]++;
      s.sum_ms += opts.duration_ms;
      s.count++;
    }
  }

  /** JSON snapshot — used by the cockpit metrics page. */
  snapshot(): Array<{
    tool_name: string;
    compensator_kind: string;
    total: ToolKindStats['total'];
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    mean_ms: number;
    success_rate: number;
  }> {
    const out: any[] = [];
    for (const [key, s] of this.byKey) {
      const [tool, kind] = key.split('::');
      const total = sumOutcomes(s.total);
      const success = s.total.rolled_back + s.total.no_op;
      out.push({
        tool_name: tool,
        compensator_kind: kind,
        total: s.total,
        p50_ms: quantile(s.hist, 0.50),
        p95_ms: quantile(s.hist, 0.95),
        p99_ms: quantile(s.hist, 0.99),
        mean_ms: s.count > 0 ? s.sum_ms / s.count : 0,
        success_rate: total > 0 ? success / total : 0,
      });
    }
    return out;
  }

  /** Render the snapshot in Prometheus text exposition format. */
  prometheus(): string {
    const lines: string[] = [];
    lines.push('# HELP aegis_rollback_total Total rollback attempts');
    lines.push('# TYPE aegis_rollback_total counter');
    for (const [key, s] of this.byKey) {
      const [tool, kind] = key.split('::');
      for (const outcome of Object.keys(s.total) as RollbackOutcome[]) {
        lines.push(
          `aegis_rollback_total{tool=${q(tool)},compensator=${q(kind)},outcome=${q(outcome)}} ${s.total[outcome]}`,
        );
      }
    }
    lines.push('');
    lines.push('# HELP aegis_rollback_duration_ms Compensator execution time histogram');
    lines.push('# TYPE aegis_rollback_duration_ms histogram');
    for (const [key, s] of this.byKey) {
      const [tool, kind] = key.split('::');
      const labels = `tool=${q(tool)},compensator=${q(kind)}`;
      let cumulative = 0;
      for (let i = 0; i < BUCKET_EDGES_MS.length; i++) {
        cumulative += s.hist[i];
        lines.push(`aegis_rollback_duration_ms_bucket{${labels},le="${BUCKET_EDGES_MS[i].toFixed(2)}"} ${cumulative}`);
      }
      cumulative += s.hist[NUM_BUCKETS - 1];
      lines.push(`aegis_rollback_duration_ms_bucket{${labels},le="+Inf"} ${cumulative}`);
      lines.push(`aegis_rollback_duration_ms_sum{${labels}} ${s.sum_ms.toFixed(3)}`);
      lines.push(`aegis_rollback_duration_ms_count{${labels}} ${s.count}`);
    }
    return lines.join('\n');
  }

  /** Reset all counters — for tests + administrative use. */
  reset(): void { this.byKey.clear(); }
}

function sumOutcomes(t: ToolKindStats['total']): number {
  return t.rolled_back + t.failed + t.unsupported + t.no_op;
}

/** Approximate quantile from a fixed-edge histogram. Linear
 *  interpolation within the bucket. */
function quantile(hist: number[], q: number): number {
  let total = 0;
  for (const v of hist) total += v;
  if (total === 0) return 0;
  const target = q * total;
  let cumulative = 0;
  for (let i = 0; i < hist.length; i++) {
    cumulative += hist[i];
    if (cumulative >= target) {
      const lo = i === 0 ? 0 : BUCKET_EDGES_MS[i - 1];
      const hi = i < BUCKET_EDGES_MS.length ? BUCKET_EDGES_MS[i] : BUCKET_EDGES_MS[BUCKET_EDGES_MS.length - 1] * 2;
      return (lo + hi) / 2;
    }
  }
  return BUCKET_EDGES_MS[BUCKET_EDGES_MS.length - 1];
}

function q(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
