/**
 * Policy effectiveness scorer.
 *
 * Computes per-policy precision / recall / F1 / FP rate over a rolling
 * window. Powers the cockpit "Policy Effectiveness" panel + the
 * "retire this policy" suggestion engine.
 *
 * Data sources:
 *   - violations table       — every time a policy FIRED on a tool call
 *   - approvals table        — human verdicts on the SAME tool calls
 *
 * Definitions (SOC2 + EU AI Act both expect this exact framing):
 *
 *   - TP  (true positive)   — policy fired AND human rejected
 *   - FP  (false positive)  — policy fired AND human approved
 *   - FN  (false negative)  — human rejected on a call where THIS
 *                             policy did NOT fire (caught by another
 *                             policy or by oversight). We approximate
 *                             FN as approvals.status=REJECTED minus the
 *                             violation rows for this policy — a lower
 *                             bound, but the only well-defined source
 *                             without ground-truth labels.
 *   - TN — undefined in our setting (we don't see the universe of
 *          good calls in scope).
 *
 *   precision = TP / (TP + FP)
 *   recall    = TP / (TP + FN)
 *   F1        = 2 * P * R / (P + R)
 *   fp_rate   = FP / (TP + FP)            (alias 1 - precision)
 *
 * Industry signal lines we report alongside the F1:
 *   - "RETIRE"   FP rate ≥ 90% AND ≥ 50 fires in window  — kills noise
 *   - "TIGHTEN"  FN ≥ TP AND ≥ 10 missed                  — policy too loose
 *   - "HEALTHY"  precision ≥ 0.8 AND recall ≥ 0.5
 *   - "PROBE"    fewer than 10 total fires — too little data
 */

import type Database from 'better-sqlite3';

export type EffectivenessSignal = 'RETIRE' | 'TIGHTEN' | 'HEALTHY' | 'PROBE';

export interface PolicyEffectivenessRow {
  policy_id: string;
  fired_count: number;
  true_positives: number;
  false_positives: number;
  false_negatives_est: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  fp_rate: number | null;
  signal: EffectivenessSignal;
  recommendation: string;
}

export interface EffectivenessReport {
  window: { from_iso: string; to_iso: string; hours: number };
  org_id?: string;
  rows: PolicyEffectivenessRow[];
  summary: {
    policies_evaluated: number;
    healthy: number;
    needs_tightening: number;
    candidates_to_retire: number;
  };
}

export interface EffectivenessOpts {
  org_id?: string;
  hours?: number;     // default 168 (7 days)
}

export class PolicyEffectivenessService {
  constructor(private db: Database.Database) {}

  /** Compute the effectiveness rollup. SQLite-only today; the runbook
   *  documents how to lift this onto Postgres via the ViolationsStore +
   *  ApprovalsStore async APIs (one query each, no joins). */
  compute(opts: EffectivenessOpts = {}): EffectivenessReport {
    const hours = Math.max(1, Math.min(opts.hours ?? 168, 24 * 90));   // cap at 90 days
    const fromIso = new Date(Date.now() - hours * 3600_000).toISOString();
    const toIso   = new Date().toISOString();

    // ── 1. Fires per policy from `violations` ──────────────────
    // Each row in violations means a policy fired AND a violation was
    // recorded. We bucket by policy_id.
    const fires = this.db.prepare(
      `SELECT policy_id, COUNT(*) AS fires, GROUP_CONCAT(trace_id) AS traces
       FROM violations
       WHERE created_at >= ? ${opts.org_id ? '' /* violations table doesn't carry org_id yet */ : ''}
       GROUP BY policy_id`,
    ).all(fromIso) as any[];

    // ── 2. Approval verdicts per trace_id from `approvals` ─────
    // Trace ids the human approved vs rejected — our ground truth.
    const verdicts = new Map<string, 'APPROVED' | 'REJECTED' | 'EXPIRED'>();
    const verdictRows = this.db.prepare(
      `SELECT trace_id, status FROM approvals WHERE created_at >= ?`,
    ).all(fromIso) as any[];
    for (const r of verdictRows) verdicts.set(r.trace_id, r.status);

    // ── 3. Per-policy precision / recall ──────────────────────
    const rows: PolicyEffectivenessRow[] = [];
    const totalRejected = verdictRows.filter(r => r.status === 'REJECTED').length;

    for (const f of fires) {
      const traces = (f.traces ?? '').split(',').filter(Boolean) as string[];
      let tp = 0, fp = 0;
      for (const t of traces) {
        const v = verdicts.get(t);
        if (v === 'REJECTED') tp++;
        else if (v === 'APPROVED') fp++;
      }
      // FN estimate: rejected traces this policy did NOT participate in.
      const fn = Math.max(0, totalRejected - tp);
      const precision = tp + fp > 0 ? tp / (tp + fp) : null;
      const recall    = tp + fn > 0 ? tp / (tp + fn) : null;
      const fp_rate   = tp + fp > 0 ? fp / (tp + fp) : null;
      const f1 = (precision !== null && recall !== null && precision + recall > 0)
        ? (2 * precision * recall) / (precision + recall)
        : null;

      const { signal, recommendation } = classify({
        fires: f.fires, tp, fp, fn, precision, recall,
      });

      rows.push({
        policy_id: f.policy_id,
        fired_count: f.fires,
        true_positives: tp,
        false_positives: fp,
        false_negatives_est: fn,
        precision, recall, f1, fp_rate,
        signal,
        recommendation,
      });
    }

    rows.sort((a, b) => b.fired_count - a.fired_count);

    return {
      window: { from_iso: fromIso, to_iso: toIso, hours },
      org_id: opts.org_id,
      rows,
      summary: {
        policies_evaluated: rows.length,
        healthy:            rows.filter(r => r.signal === 'HEALTHY').length,
        needs_tightening:   rows.filter(r => r.signal === 'TIGHTEN').length,
        candidates_to_retire: rows.filter(r => r.signal === 'RETIRE').length,
      },
    };
  }
}

function classify(opts: {
  fires: number; tp: number; fp: number; fn: number;
  precision: number | null; recall: number | null;
}): { signal: EffectivenessSignal; recommendation: string } {
  const { fires, tp, fp, fn, precision, recall } = opts;
  if (fires < 10) {
    return {
      signal: 'PROBE',
      recommendation: `Only ${fires} fires in window — not enough data; keep collecting.`,
    };
  }
  if (precision !== null && precision <= 0.1 && fires >= 50) {
    return {
      signal: 'RETIRE',
      recommendation: `False-positive rate is ${Math.round((fp / (tp + fp)) * 100)}%. Consider retiring this policy or narrowing the pattern.`,
    };
  }
  if (fn > tp && fn >= 10) {
    return {
      signal: 'TIGHTEN',
      recommendation: `Missed ${fn} likely violations vs ${tp} caught. Add cases to the policy or generate a tighter variant via AI.`,
    };
  }
  if (precision !== null && precision >= 0.8 && recall !== null && recall >= 0.5) {
    return {
      signal: 'HEALTHY',
      recommendation: `Healthy: precision ${(precision * 100).toFixed(0)}%, recall ${(recall * 100).toFixed(0)}%.`,
    };
  }
  return {
    signal: 'PROBE',
    recommendation: `Mixed signal — precision ${precision !== null ? (precision * 100).toFixed(0) + '%' : 'n/a'}, recall ${recall !== null ? (recall * 100).toFixed(0) + '%' : 'n/a'}.`,
  };
}
