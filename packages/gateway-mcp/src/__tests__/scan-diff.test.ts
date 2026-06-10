import { diffFindings } from '../services/scan-diff';
import { AegisFinding } from '../services/predeploy-scan';

function f(opts: Partial<AegisFinding> & { rule_id: string; file: string; line: number; title?: string }): AegisFinding {
  return {
    rule_id: opts.rule_id,
    title: opts.title ?? `Finding ${opts.rule_id}`,
    severity: opts.severity ?? 'medium',
    tier: opts.tier ?? 'WARN',
    location: { file_path: opts.file, start_line: opts.line },
    ...opts,
  };
}

describe('scan-diff', () => {
  it('classifies disjoint scans entirely as added / removed', () => {
    const base    = [f({ rule_id: 'A', file: 'a.py', line: 1 })];
    const compare = [f({ rule_id: 'B', file: 'b.py', line: 2 })];
    const d = diffFindings(base, compare);
    expect(d.added.length).toBe(1);
    expect(d.added[0].rule_id).toBe('B');
    expect(d.removed.length).toBe(1);
    expect(d.removed[0].rule_id).toBe('A');
    expect(d.persisted).toHaveLength(0);
  });

  it('identical scans → all persisted, nothing added/removed', () => {
    const same = [
      f({ rule_id: 'A', file: 'a.py', line: 1 }),
      f({ rule_id: 'B', file: 'b.py', line: 5 }),
    ];
    const d = diffFindings(same, [...same]);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.persisted).toHaveLength(2);
  });

  it('mixed: one fixed, one new, one persisted', () => {
    const base = [
      f({ rule_id: 'A', file: 'a.py', line: 1 }),
      f({ rule_id: 'B', file: 'b.py', line: 5 }),
    ];
    const compare = [
      f({ rule_id: 'B', file: 'b.py', line: 5 }),
      f({ rule_id: 'C', file: 'c.py', line: 10 }),
    ];
    const d = diffFindings(base, compare);
    expect(d.added.map(x => x.rule_id)).toEqual(['C']);
    expect(d.removed.map(x => x.rule_id)).toEqual(['A']);
    expect(d.persisted.map(x => x.rule_id)).toEqual(['B']);
  });

  it('summary.block_delta is positive when new BLOCKs appear', () => {
    const base = [
      f({ rule_id: 'X', file: 'a.py', line: 1, tier: 'WARN' }),
    ];
    const compare = [
      f({ rule_id: 'X', file: 'a.py', line: 1, tier: 'WARN' }),
      f({ rule_id: 'Y', file: 'b.py', line: 2, tier: 'BLOCK' }),
    ];
    const d = diffFindings(base, compare);
    expect(d.summary.block_delta).toBe(1);
    expect(d.summary.added_count).toBe(1);
  });

  it('summary.critical_delta is negative when critical findings dropped', () => {
    const base = [
      f({ rule_id: 'X', file: 'a.py', line: 1, severity: 'critical' }),
      f({ rule_id: 'Y', file: 'b.py', line: 2, severity: 'critical' }),
    ];
    const compare = [
      f({ rule_id: 'X', file: 'a.py', line: 1, severity: 'critical' }),
    ];
    const d = diffFindings(base, compare);
    expect(d.summary.critical_delta).toBe(-1);
  });

  it('two findings on the same line with different titles are NOT collapsed', () => {
    const base    = [f({ rule_id: 'A', file: 'a.py', line: 1, title: 'first' })];
    const compare = [
      f({ rule_id: 'A', file: 'a.py', line: 1, title: 'first' }),
      f({ rule_id: 'A', file: 'a.py', line: 1, title: 'second' }),
    ];
    const d = diffFindings(base, compare);
    expect(d.persisted).toHaveLength(1);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].title).toBe('second');
  });

  it('orders results: critical first, then by file path', () => {
    const base = [];
    const compare = [
      f({ rule_id: 'C', file: 'c.py', line: 1, severity: 'low' }),
      f({ rule_id: 'A', file: 'a.py', line: 1, severity: 'critical' }),
      f({ rule_id: 'B', file: 'b.py', line: 1, severity: 'medium' }),
    ];
    const d = diffFindings(base, compare);
    expect(d.added.map(x => x.severity)).toEqual(['critical', 'medium', 'low']);
  });

  it('counts match', () => {
    const base    = [f({ rule_id: 'A', file: 'a.py', line: 1 }), f({ rule_id: 'B', file: 'b.py', line: 1 })];
    const compare = [f({ rule_id: 'B', file: 'b.py', line: 1 }), f({ rule_id: 'C', file: 'c.py', line: 1 })];
    const d = diffFindings(base, compare);
    expect(d.summary.base_count).toBe(2);
    expect(d.summary.compare_count).toBe(2);
    expect(d.summary.added_count).toBe(1);
    expect(d.summary.removed_count).toBe(1);
    expect(d.summary.persisted_count).toBe(1);
  });

  it('handles empty inputs', () => {
    expect(diffFindings([], []).summary).toEqual({
      base_count: 0, compare_count: 0, added_count: 0, removed_count: 0, persisted_count: 0,
      block_delta: 0, critical_delta: 0,
    });
    expect(diffFindings([f({ rule_id: 'A', file: 'a.py', line: 1 })], []).removed).toHaveLength(1);
    expect(diffFindings([], [f({ rule_id: 'A', file: 'a.py', line: 1 })]).added).toHaveLength(1);
  });
});
