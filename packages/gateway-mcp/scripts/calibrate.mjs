#!/usr/bin/env node
/**
 * AEGIS Layer 3 calibration CLI.
 *
 *   node scripts/calibrate.mjs                              # builtin benchmark, mock judge
 *   node scripts/calibrate.mjs --benchmark ./mine.jsonl     # external benchmark
 *   node scripts/calibrate.mjs --out ../../docs/CALIBRATION-REPORT.md
 *
 * Adapters for real judges (OpenAI / Anthropic / local SLM) plug in via
 * the `JudgeFn` interface exported from `src/calibration/runner.ts`.
 * The default is a deterministic mock so this script runs with zero
 * credentials in CI.
 */

import { argv, exit, stdout, env } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

// ── Load .env.local (KEY=value lines) without a dep ────────────────
for (const envFile of ['.env.local', '.env']) {
  const p = path.join(pkgRoot, envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (!env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Resolve compiled dist if present, fall back to ts-node–style source.
// Production runs use `npm run build` first, so this should always
// resolve to dist/.
const distEntry = path.join(pkgRoot, 'dist', 'calibration', 'index.js');
if (!fs.existsSync(distEntry)) {
  console.error(`[calibrate] ${distEntry} not found. Run \`npm run build\` first.`);
  exit(1);
}
const mod = await import(distEntry);

// ── CLI parsing ─────────────────────────────────────────────────────
const args = parseArgs(argv.slice(2));
const benchmarkPath = args['--benchmark'];
const outPath = args['--out'] ?? path.resolve(pkgRoot, '..', '..', 'docs', 'CALIBRATION-REPORT.md');
const judgeSpec = args['--judge'] ?? 'mock';

// ── Load benchmark ──────────────────────────────────────────────────
const benchmark = benchmarkPath
  ? mod.loadFromPath(benchmarkPath)
  : mod.loadBuiltin();
console.log(`[calibrate] loaded benchmark ${benchmark.name}@${benchmark.version} (${benchmark.cases.length} cases)`);

// ── Pick a judge ────────────────────────────────────────────────────
// Format:  mock | openai[:model] | anthropic[:model]
let judge, judgeLabel;
if (judgeSpec === 'mock') {
  judge = mod.mockJudge;
  judgeLabel = 'mock';
} else if (judgeSpec.startsWith('openai')) {
  const model = judgeSpec.split(':')[1] || 'gpt-4o-mini';
  if (!env.OPENAI_API_KEY) {
    console.error('[calibrate] OPENAI_API_KEY not set (looked in .env.local + env).');
    exit(2);
  }
  judge = mod.openAIJudge({ apiKey: env.OPENAI_API_KEY, model, minIntervalMs: Number(args['--min-interval-ms'] ?? 5000) });
  judgeLabel = `openai/${model}`;
} else if (judgeSpec.startsWith('anthropic')) {
  const model = judgeSpec.split(':')[1] || 'claude-haiku-4-5-20251001';
  if (!env.ANTHROPIC_API_KEY) {
    console.error('[calibrate] ANTHROPIC_API_KEY not set (looked in .env.local + env).');
    exit(2);
  }
  judge = mod.anthropicJudge({ apiKey: env.ANTHROPIC_API_KEY, model });
  judgeLabel = `anthropic/${model}`;
} else {
  console.error(`[calibrate] unknown judge "${judgeSpec}". Use: mock | openai[:model] | anthropic[:model]`);
  exit(2);
}
console.log(`[calibrate] judge: ${judgeLabel}`);

// ── Run ─────────────────────────────────────────────────────────────
let done = 0;
const t0 = Date.now();
const concurrency = Number(args['--concurrency'] ?? (judgeSpec === 'mock' ? 4 : 2));
const report = await mod.runCalibration(benchmark, judge, {
  judgeName:   judgeLabel,
  concurrency,
  onProgress: (d, total) => {
    done = d;
    stdout.write(`\r[calibrate] judging ${d}/${total}  `);
  },
});
stdout.write('\n');
console.log(`[calibrate] done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ECE=${(report.overall.ece * 100).toFixed(1)}% · acc=${(report.overall.accuracy * 100).toFixed(1)}%`);

// Warn (don't fail) if the judge errored on any case — fallback rows
// have predicted='escalate' / confidence=0.5 and pollute the numbers.
const fallbackRows = report.rows.filter(r => r.fallback);
if (fallbackRows.length > 0) {
  console.error(`[calibrate] WARNING: ${fallbackRows.length}/${report.rows.length} rows fell back to default — judge errored.`);
  console.error('[calibrate] Set AEGIS_CALIBRATE_DEBUG=1 to see per-case errors. Common causes: rate limit (429), missing API key.');
}

// ── Render + write ──────────────────────────────────────────────────
const md = mod.renderMarkdown(report);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, md, 'utf-8');
console.log(`[calibrate] wrote ${outPath}`);

// ── helpers ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a] = argv[++i] ?? true;
  }
  return out;
}
