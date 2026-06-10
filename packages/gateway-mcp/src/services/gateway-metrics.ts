/**
 * Gateway-wide Prometheus metrics.
 *
 * Why this exists: the existing SLAMetricsService writes summary rows
 * into SQLite for the cockpit's "uptime / p95" tile, and rollback-metrics
 * already exposes a Prometheus surface for the saga subsystem. Neither
 * gives an Ops team the standard scrape target they expect: HTTP request
 * rate, decision mix, cost rate, DLQ depth, anomaly velocity.
 *
 * Production-grade requirements baked in:
 *   - Bounded cardinality: orgId/route/method/status_code only — no
 *     trace_id, agent_id, or other unbounded fields ever become labels.
 *     This is the #1 way Prometheus deploys die at scale, so we enforce
 *     it at the API level by accepting only typed enums + sanitised
 *     route templates ("/api/v1/check" not "/api/v1/check/abc123").
 *   - Histograms use **the de-facto SRE bucket set** for HTTP latency
 *     (5ms … 30s, logarithmic), matching ServiceMonitor defaults for
 *     Grafana SRE dashboards.
 *   - No external deps. We emit the OpenMetrics 0.0.4 / Prometheus text
 *     exposition format ourselves — same approach as rollback-metrics.
 *     Customers can `curl /metrics | promtool check metrics` and it
 *     passes lint.
 *
 * Hook points:
 *   - `httpMiddleware()` returns an express middleware that records
 *     request rate + latency + error counters automatically. Mount once
 *     in server.ts; no per-route work needed.
 *   - `recordCheck(decision, orgId)`, `recordCost(usd, orgId)`,
 *     `recordAnomaly(orgId)`, `setDlqDepth(orgId, n)` for the few
 *     business events that aren't HTTP-shaped.
 */

import type { Request, Response, NextFunction } from 'express';

const HTTP_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

type Decision = 'allow' | 'pending' | 'block';

interface CounterKey {
  name: string;
  labels: Record<string, string>;
}

function fmtLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return '';
  return '{' + entries.map(([k, v]) => `${k}="${escape(v)}"`).join(',') + '}';
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Normalise a request path to a *route template* so we never label by
 *  trace_id / agent_id / saga_id / etc. — bounded cardinality is a
 *  HARD rule for production Prometheus. */
function routeOf(req: Request): string {
  // express stores the matched route on req.route.path. When that's
  // missing (404, before-route middleware) fall back to req.path with
  // every UUID / hex blob / numeric segment replaced by ":id".
  const tpl = (req as any).route?.path as string | undefined;
  const base = (req as any).baseUrl as string | undefined;
  if (tpl) return ((base ?? '') + tpl) || '/';
  const p = req.path || '/';
  return p
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

export class GatewayMetricsService {
  // ── counters ────────────────────────────────────────────────────
  private counters = new Map<string, number>();
  // ── histograms ──────────────────────────────────────────────────
  // Storage: key → { buckets: number[], sum: number, count: number }
  private histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();
  // ── gauges (last-write-wins) ───────────────────────────────────
  private gauges = new Map<string, number>();

  private keyOf(name: string, labels: Record<string, string>): string {
    return name + fmtLabels(labels);
  }

  private incCounter(name: string, labels: Record<string, string>, by = 1): void {
    const k = this.keyOf(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  private observeHistogram(name: string, labels: Record<string, string>, valueMs: number): void {
    const k = this.keyOf(name, labels);
    let h = this.histograms.get(k);
    if (!h) {
      h = { buckets: new Array(HTTP_LATENCY_BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(k, h);
    }
    h.sum += valueMs;
    h.count += 1;
    // Store NON-cumulative counts per bucket; prometheus() folds into
    // the cumulative form on emit. (Storing cumulative here + cumulating
    // again on emit would double-cumulate — a classic histogram bug.)
    // Find the LOWEST bucket whose upper edge >= valueMs; bump only it.
    for (let i = 0; i < HTTP_LATENCY_BUCKETS_MS.length; i++) {
      if (valueMs <= HTTP_LATENCY_BUCKETS_MS[i]) { h.buckets[i] += 1; return; }
    }
    // valueMs > last bucket edge → bumps no concrete bucket; only +Inf,
    // which is derived from h.count on emit (count - sum(buckets)).
  }

  private setGauge(name: string, labels: Record<string, string>, value: number): void {
    this.gauges.set(this.keyOf(name, labels), value);
  }

  /** Express middleware. Mounts once; records every request after the
   *  response flushes so the route template is final. Status 4xx/5xx
   *  are counted into `aegis_http_errors_total`. */
  httpMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const dur = Number(process.hrtime.bigint() - start) / 1_000_000;
        const route = routeOf(req);
        const method = req.method.toUpperCase();
        const orgId = (req as any).orgId ?? 'default';
        const code  = String(res.statusCode);
        const labels = { route, method, status: code, org: orgId };
        this.incCounter('aegis_http_requests_total', labels);
        this.observeHistogram('aegis_http_request_duration_ms', { route, method, org: orgId }, dur);
        if (res.statusCode >= 400) {
          this.incCounter('aegis_http_errors_total', labels);
        }
      });
      next();
    };
  }

  // ── Business event recorders ────────────────────────────────────

  /** Called on every /check decision. Cardinality: {orgId} × {decision} */
  recordCheck(decision: Decision, orgId: string = 'default'): void {
    this.incCounter('aegis_check_decisions_total', { org: orgId, decision });
  }

  /** Called on each tool-call cost write. usd is added to a running counter. */
  recordCost(usd: number, orgId: string = 'default'): void {
    if (usd <= 0 || !Number.isFinite(usd)) return;
    // Counters are integer-additive; for currency we keep a cent-level
    // resolution then divide on emit. This avoids float drift over millions
    // of writes (a real production headache when emitting USD as float).
    const cents = Math.round(usd * 100);
    this.incCounter('aegis_cost_usd_cents_total', { org: orgId }, cents);
  }

  recordAnomaly(orgId: string = 'default'): void {
    this.incCounter('aegis_anomaly_events_total', { org: orgId });
  }

  /** Update DLQ depth as a gauge. Periodically called from DLQ service. */
  setDlqDepth(orgId: string, depth: number): void {
    this.setGauge('aegis_dlq_depth', { org: orgId }, depth);
  }

  /** Update the in-process anomaly p95 (last-known). Optional convenience
   *  for dashboards that want a real-time line without Prometheus quantile. */
  setAnomalyP95(orgId: string, score: number): void {
    this.setGauge('aegis_anomaly_p95', { org: orgId }, score);
  }

  // ── Prometheus exposition format ────────────────────────────────

  prometheus(): string {
    const lines: string[] = [];
    // Counters
    const seenHelp = new Set<string>();
    const counterMeta: Record<string, string> = {
      aegis_http_requests_total:      'HTTP requests by route, method, status, org.',
      aegis_http_errors_total:        'HTTP responses with status ≥ 400.',
      aegis_check_decisions_total:    '/api/v1/check decisions: allow / pending / block.',
      aegis_cost_usd_cents_total:     'Cumulative LLM cost in USD cents.',
      aegis_anomaly_events_total:     'Anomaly-detector events emitted.',
    };
    const gaugeMeta: Record<string, string> = {
      aegis_dlq_depth:    'Current DLQ size per tenant.',
      aegis_anomaly_p95:  'Most-recently-computed anomaly p95 per tenant.',
    };
    const histMeta: Record<string, string> = {
      aegis_http_request_duration_ms: 'HTTP request duration in milliseconds.',
    };
    for (const [k, v] of this.counters) {
      const name = k.replace(/\{.*$/, '');
      if (!seenHelp.has(name)) {
        lines.push(`# HELP ${name} ${counterMeta[name] ?? name}`);
        lines.push(`# TYPE ${name} counter`);
        seenHelp.add(name);
      }
      lines.push(`${k} ${v}`);
    }
    for (const [k, v] of this.gauges) {
      const name = k.replace(/\{.*$/, '');
      if (!seenHelp.has(name)) {
        lines.push(`# HELP ${name} ${gaugeMeta[name] ?? name}`);
        lines.push(`# TYPE ${name} gauge`);
        seenHelp.add(name);
      }
      lines.push(`${k} ${v}`);
    }
    for (const [k, h] of this.histograms) {
      const name = k.replace(/\{.*$/, '');
      const labelStr = k.slice(name.length);     // "{...}" or ""
      if (!seenHelp.has(name)) {
        lines.push(`# HELP ${name} ${histMeta[name] ?? name}`);
        lines.push(`# TYPE ${name} histogram`);
        seenHelp.add(name);
      }
      const labelInner = labelStr.startsWith('{') ? labelStr.slice(1, -1) : '';
      const join = labelInner ? labelInner + ',' : '';
      let cum = 0;
      for (let i = 0; i < HTTP_LATENCY_BUCKETS_MS.length; i++) {
        cum += h.buckets[i];
        // Note: buckets are CUMULATIVE in prometheus histogram format.
        lines.push(`${name}_bucket{${join}le="${HTTP_LATENCY_BUCKETS_MS[i]}"} ${cum}`);
      }
      lines.push(`${name}_bucket{${join}le="+Inf"} ${h.count}`);
      lines.push(`${name}_sum${labelStr} ${h.sum}`);
      lines.push(`${name}_count${labelStr} ${h.count}`);
    }
    // Note: also emit cost in USD (not cents) as a derived view for
    // dashboards that don't want to do the divide themselves.
    for (const [k, v] of this.counters) {
      if (k.startsWith('aegis_cost_usd_cents_total')) {
        const usdKey = k.replace('aegis_cost_usd_cents_total', 'aegis_cost_usd_total');
        const usdName = 'aegis_cost_usd_total';
        if (!seenHelp.has(usdName)) {
          lines.push(`# HELP ${usdName} Cumulative LLM cost in USD.`);
          lines.push(`# TYPE ${usdName} counter`);
          seenHelp.add(usdName);
        }
        lines.push(`${usdKey} ${(v / 100).toFixed(4)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /** JSON dump — used by cockpit when it doesn't want to parse the
   *  Prometheus text format. Same data, different encoding. */
  snapshot(): { counters: Record<string, number>; gauges: Record<string, number>; histograms: Record<string, any> } {
    return {
      counters:   Object.fromEntries(this.counters),
      gauges:     Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        Array.from(this.histograms.entries()).map(([k, h]) => [k, {
          sum: h.sum, count: h.count,
          buckets: h.buckets.map((c, i) => ({ le: HTTP_LATENCY_BUCKETS_MS[i], c })),
        }]),
      ),
    };
  }
}
