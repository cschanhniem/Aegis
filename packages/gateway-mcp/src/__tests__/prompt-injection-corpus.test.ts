/**
 * Prompt-injection corpus + coverage evaluator tests.
 *
 * Pins:
 *   - Corpus has the documented breadth: every category × severity
 *     combination we ship is represented.
 *   - Evaluator runs every entry through the supplied predicate and
 *     reports caught / missed correctly.
 *   - Coverage rollups (per-category, per-severity) match hand-counted
 *     truth on a fixed predicate.
 *   - worst_misses is sorted CRITICAL → HIGH → MEDIUM → LOW.
 */
import {
  PROMPT_INJECTION_CORPUS,
  evaluatePromptInjectionCoverage,
  predicateEvaluator,
} from '../services/prompt-injection-corpus';

describe('PROMPT_INJECTION_CORPUS — shape + coverage of attack classes', () => {
  test('every entry has the required fields', () => {
    for (const e of PROMPT_INJECTION_CORPUS) {
      expect(e.id).toBeTruthy();
      expect(['override', 'jailbreak', 'leak', 'tool_abuse', 'indirect', 'multilingual']).toContain(e.category);
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).toContain(e.severity);
      expect(e.prompt.length).toBeGreaterThan(10);
      expect(e.signature.length).toBeGreaterThan(2);
      expect(e.source.length).toBeGreaterThan(2);
    }
  });

  test('corpus covers every documented category', () => {
    const cats = new Set(PROMPT_INJECTION_CORPUS.map(e => e.category));
    expect(cats.has('override')).toBe(true);
    expect(cats.has('jailbreak')).toBe(true);
    expect(cats.has('leak')).toBe(true);
    expect(cats.has('tool_abuse')).toBe(true);
    expect(cats.has('indirect')).toBe(true);
    expect(cats.has('multilingual')).toBe(true);
  });

  test('corpus has at least 20 entries — meaningful coverage', () => {
    expect(PROMPT_INJECTION_CORPUS.length).toBeGreaterThanOrEqual(20);
  });

  test('ids are unique', () => {
    const ids = PROMPT_INJECTION_CORPUS.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('evaluatePromptInjectionCoverage — runner', () => {
  test('predicate that catches "ignore" patterns reports honest coverage', async () => {
    const r = await evaluatePromptInjectionCoverage(
      predicateEvaluator(s => /ignore/i.test(s)),
    );
    expect(r.total).toBe(PROMPT_INJECTION_CORPUS.length);
    expect(r.caught).toBeGreaterThan(0);
    expect(r.coverage_pct).toBeGreaterThan(0);
    expect(r.coverage_pct).toBeLessThanOrEqual(100);
  });

  test('always-true predicate gives 100% coverage', async () => {
    const r = await evaluatePromptInjectionCoverage(
      predicateEvaluator(() => true),
    );
    expect(r.caught).toBe(r.total);
    expect(r.coverage_pct).toBe(100);
    expect(r.worst_misses).toEqual([]);
  });

  test('always-false predicate gives 0% coverage + worst_misses sorted CRITICAL first', async () => {
    const r = await evaluatePromptInjectionCoverage(
      predicateEvaluator(() => false),
    );
    expect(r.caught).toBe(0);
    expect(r.missed).toBe(r.total);
    // worst_misses caps at 10
    expect(r.worst_misses.length).toBeLessThanOrEqual(10);
    // First entry should be CRITICAL severity if any exist in the corpus
    expect(r.worst_misses[0]?.entry.severity).toBe('CRITICAL');
  });

  test('include_categories filter scopes the run', async () => {
    const r = await evaluatePromptInjectionCoverage(
      predicateEvaluator(() => true),
      { include_categories: ['leak'] },
    );
    expect(r.total).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.entry.category).toBe('leak');
  });

  test('by_category rollup is internally consistent', async () => {
    const r = await evaluatePromptInjectionCoverage(
      predicateEvaluator(s => /database|sql|shell/i.test(s)),
    );
    // For each category, caught/total in rollup matches hand-count over rows.
    for (const cat of Object.keys(r.by_category)) {
      const rowsInCat = r.rows.filter(x => x.entry.category === cat);
      expect(r.by_category[cat].total).toBe(rowsInCat.length);
      expect(r.by_category[cat].caught).toBe(rowsInCat.filter(x => x.caught).length);
    }
  });

  test('by_severity rollup is internally consistent', async () => {
    const r = await evaluatePromptInjectionCoverage(
      predicateEvaluator(s => /ignore/i.test(s)),
    );
    for (const sev of Object.keys(r.by_severity)) {
      const rowsInSev = r.rows.filter(x => x.entry.severity === sev);
      expect(r.by_severity[sev].total).toBe(rowsInSev.length);
      expect(r.by_severity[sev].caught).toBe(rowsInSev.filter(x => x.caught).length);
    }
  });

  test('evaluator errors degrade gracefully (caught=false, no crash)', async () => {
    let calls = 0;
    const r = await evaluatePromptInjectionCoverage({
      evaluate: async () => {
        calls++;
        if (calls % 3 === 0) throw new Error('evaluator boom');
        return { blocked: false };
      },
    });
    // The total still reflects every entry — error rows DO show up but caught=false.
    expect(r.total).toBe(PROMPT_INJECTION_CORPUS.length);
    expect(r.rows.length).toBe(r.total);
    const errored = r.rows.filter(row => row.reason === 'evaluator error');
    expect(errored.length).toBeGreaterThan(0);
  });

  test('worst_misses ordering: CRITICAL > HIGH > MEDIUM > LOW', async () => {
    const r = await evaluatePromptInjectionCoverage(
      predicateEvaluator(() => false),
    );
    const sev = (s: string) => ({ CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as any)[s];
    for (let i = 1; i < r.worst_misses.length; i++) {
      expect(sev(r.worst_misses[i - 1].entry.severity))
        .toBeGreaterThanOrEqual(sev(r.worst_misses[i].entry.severity));
    }
  });
});
