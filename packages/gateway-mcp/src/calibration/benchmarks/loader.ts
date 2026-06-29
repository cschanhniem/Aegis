/**
 * Benchmark loader. Reads the in-tree builtin JSON or an external
 * JSONL/JSON file matching {@link CalibrationBenchmark}.
 *
 * External format (JSONL — one case per line):
 *   {"id":"j-XXX","category":"jailbreak","trace":{...},"truth":"block"}
 *
 * External format (JSON):
 *   { "name": "...", "version": "...", "cases": [ ... ] }
 *
 * Validation is deliberately strict — a typo in a benchmark file is a
 * silent disaster for an ECE report.
 */

import fs from 'node:fs';
import path from 'node:path';
import builtinJson from './builtin.json';
import type { CalibrationBenchmark, CalibrationCase, GroundTruth } from './schema';

const VALID_TRUTHS: ReadonlySet<GroundTruth> = new Set(['allow', 'block', 'escalate']);

export function loadBuiltin(): CalibrationBenchmark {
  return validate(builtinJson as CalibrationBenchmark, '<builtin>');
}

/** Load a benchmark from a `.json` or `.jsonl` file. */
export function loadFromPath(filePath: string): CalibrationBenchmark {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf-8');

  if (abs.endsWith('.jsonl')) {
    const cases = raw
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map((line, i) => {
        try { return JSON.parse(line) as CalibrationCase; }
        catch (e) { throw new Error(`${abs}:${i + 1}: invalid JSON — ${(e as Error).message}`); }
      });
    return validate({
      name:    path.basename(abs, '.jsonl'),
      version: '<external>',
      cases,
    }, abs);
  }

  const parsed = JSON.parse(raw) as CalibrationBenchmark;
  return validate(parsed, abs);
}

function validate(b: CalibrationBenchmark, src: string): CalibrationBenchmark {
  if (!b || typeof b !== 'object') throw new Error(`${src}: not an object`);
  if (!Array.isArray(b.cases) || b.cases.length === 0) {
    throw new Error(`${src}: missing or empty 'cases' array`);
  }
  const seen = new Set<string>();
  for (const [i, c] of b.cases.entries()) {
    if (typeof c.id !== 'string' || c.id.length === 0) {
      throw new Error(`${src} case[${i}]: missing 'id'`);
    }
    if (seen.has(c.id)) {
      throw new Error(`${src} case[${i}]: duplicate id '${c.id}'`);
    }
    seen.add(c.id);
    if (typeof c.category !== 'string') {
      throw new Error(`${src} case ${c.id}: missing 'category'`);
    }
    if (!VALID_TRUTHS.has(c.truth)) {
      throw new Error(`${src} case ${c.id}: 'truth' must be one of allow|block|escalate (got ${c.truth})`);
    }
    if (!c.trace || typeof c.trace !== 'object') {
      throw new Error(`${src} case ${c.id}: missing 'trace'`);
    }
    if (typeof c.trace.tool_name !== 'string') {
      throw new Error(`${src} case ${c.id}: trace.tool_name must be a string`);
    }
  }
  return b;
}
