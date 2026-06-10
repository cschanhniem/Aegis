/**
 * Scan-vs-scan diff. Compares two ScanHistoryRows and partitions
 * their findings into:
 *
 *   added       findings present in `compare` but not in `base`
 *               → likely regressions / new bugs to fix
 *   removed     findings present in `base` but not in `compare`
 *               → fixed (or codepath deleted)
 *   persisted   findings present in both
 *               → "this finding has been here a while"
 *
 * Identity hash: a finding is "the same finding" iff
 *   (rule_id, file_path, start_line, title) match exactly.
 * The title falls into the key so two distinct findings on the same
 * line (e.g. two CWE-94 hits in different functions) don't collapse.
 * Column is intentionally NOT in the key — a small refactor that
 * shifts whitespace shouldn't be reported as "fix one bug + introduce
 * an identical one."
 *
 * Diff is symmetric, deterministic, and O(|base| + |compare|).
 */

import { AegisFinding } from './predeploy-scan';

export interface ScanDiff {
  /** Findings unique to `compare`. */
  added: AegisFinding[];
  /** Findings unique to `base`. */
  removed: AegisFinding[];
  /** Findings in both (returned with the `compare` version, which may
   *  have a refreshed confidence / description). */
  persisted: AegisFinding[];
  summary: {
    base_count: number;
    compare_count: number;
    added_count: number;
    removed_count: number;
    persisted_count: number;
    /** Net delta in BLOCK-tier findings. Negative = improvement. */
    block_delta: number;
    /** Net delta in critical-severity findings. */
    critical_delta: number;
  };
}

export function diffFindings(base: AegisFinding[], compare: AegisFinding[]): ScanDiff {
  const baseMap = indexByKey(base);
  const compareMap = indexByKey(compare);

  const added: AegisFinding[] = [];
  const persisted: AegisFinding[] = [];
  for (const [k, f] of compareMap) {
    if (baseMap.has(k)) persisted.push(f);
    else                added.push(f);
  }
  const removed: AegisFinding[] = [];
  for (const [k, f] of baseMap) {
    if (!compareMap.has(k)) removed.push(f);
  }

  // Stable ordering — severity first, then path.
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, note: 4 };
  const order = (a: AegisFinding, b: AegisFinding) => {
    const ra = sevRank[a.severity] ?? 5;
    const rb = sevRank[b.severity] ?? 5;
    if (ra !== rb) return ra - rb;
    return a.location.file_path.localeCompare(b.location.file_path) || a.rule_id.localeCompare(b.rule_id);
  };
  added.sort(order); removed.sort(order); persisted.sort(order);

  const blockBase = base.filter(f => f.tier === 'BLOCK').length;
  const blockCmp  = compare.filter(f => f.tier === 'BLOCK').length;
  const critBase = base.filter(f => f.severity === 'critical').length;
  const critCmp  = compare.filter(f => f.severity === 'critical').length;

  return {
    added,
    removed,
    persisted,
    summary: {
      base_count: base.length,
      compare_count: compare.length,
      added_count: added.length,
      removed_count: removed.length,
      persisted_count: persisted.length,
      block_delta: blockCmp - blockBase,
      critical_delta: critCmp - critBase,
    },
  };
}

function keyOf(f: AegisFinding): string {
  return `${f.rule_id}::${f.location.file_path}::${f.location.start_line ?? 0}::${f.title}`;
}

function indexByKey(arr: AegisFinding[]): Map<string, AegisFinding> {
  const m = new Map<string, AegisFinding>();
  for (const f of arr) m.set(keyOf(f), f);
  return m;
}
