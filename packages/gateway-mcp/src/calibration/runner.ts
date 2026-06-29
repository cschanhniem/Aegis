/**
 * Calibration runner. Given a benchmark + a pluggable judge function,
 * collects (decision, confidence, latency) per case and produces the
 * overall + per-category ECE / reliability metrics that ship in the
 * report.
 *
 * The judge function is intentionally minimal — anyone can implement
 * it against any provider. We ship a mock judge for offline runs and
 * doc-generation, and an OpenAI / Anthropic adapter is left to the
 * caller.
 *
 * Why a pluggable judge: AEGIS Layer 3 should publish calibration *per
 * judge model*, not for a single hardcoded one — so the runner is the
 * thing that's reusable, and the provider choice is a parameter.
 */

import type { CalibrationBenchmark, CalibrationCase, GroundTruth } from './benchmarks/schema';
import {
  calibrate,
  calibrateStratified,
  type CalibrationResult,
  type Prediction,
} from './ece';

export interface JudgeOutput {
  decision: GroundTruth;
  /** Self-reported confidence in [0, 1] for {@link decision}. */
  confidence: number;
}

/** Implement this to run the runner against your own provider. */
export type JudgeFn = (c: CalibrationCase) => Promise<JudgeOutput>;

export interface RunRow {
  id: string;
  category: string;
  predicted: GroundTruth;
  confidence: number;
  truth: GroundTruth;
  latency_ms: number;
  /** True when the judge result was unparseable and we fell back to a default. */
  fallback: boolean;
}

export interface RunReport {
  benchmark: string;
  benchmark_version: string;
  judge: string;
  n: number;
  /** Wall-clock for the full run, ms. */
  total_latency_ms: number;
  /** p95 per-case latency. */
  p95_latency_ms: number;
  overall: CalibrationResult;
  by_category: Record<string, CalibrationResult>;
  /** All raw predictions in run order — useful for downstream slicing. */
  rows: RunRow[];
}

export interface RunOptions {
  /** Name to record in the report (e.g. "openai/gpt-4o-mini"). */
  judgeName: string;
  /** Reliability-bin count. Default 10. */
  nBins?: number;
  /** Max concurrent judge calls. Default 4. */
  concurrency?: number;
  /** Optional progress callback — invoked once per completed case. */
  onProgress?: (done: number, total: number, row: RunRow) => void;
}

const DEFAULT_BINS = 10;
const DEFAULT_CONCURRENCY = 4;

export async function runCalibration(
  benchmark: CalibrationBenchmark,
  judge: JudgeFn,
  opts: RunOptions,
): Promise<RunReport> {
  const nBins = opts.nBins ?? DEFAULT_BINS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const cases = benchmark.cases;

  const rows: RunRow[] = new Array(cases.length);
  let done = 0;

  // Worker pool — keeps `concurrency` judge calls in flight.
  let nextIdx = 0;
  const startedAt = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= cases.length) return;
        const c = cases[i];
        const t0 = Date.now();
        let row: RunRow;
        try {
          const out = await judge(c);
          row = {
            id: c.id,
            category: c.category,
            predicted: out.decision,
            confidence: clamp01(out.confidence),
            truth: c.truth,
            latency_ms: Date.now() - t0,
            fallback: false,
          };
        } catch (e) {
          // Judge crashed → treat as low-confidence escalate, mark fallback.
          if (process.env.AEGIS_CALIBRATE_DEBUG) {
            console.error(`[runner] case ${c.id} FAILED:`, (e as Error).message);
          }
          row = {
            id: c.id,
            category: c.category,
            predicted: 'escalate',
            confidence: 0.5,
            truth: c.truth,
            latency_ms: Date.now() - t0,
            fallback: true,
          };
        }
        rows[i] = row;
        done += 1;
        opts.onProgress?.(done, cases.length, row);
      }
    }),
  );

  const totalLatency = Date.now() - startedAt;
  const latencies = rows.map(r => r.latency_ms).sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];

  const predictions: Prediction[] = rows.map(r => ({
    predicted: r.predicted,
    confidence: r.confidence,
    truth: r.truth,
  }));

  const overall = calibrate(predictions, nBins);
  // Stratify by category — the headline ICLR 2025 finding is jailbreak
  // miscalibration, so this slice IS the report's reason to exist.
  const by_category = calibrateStratified(
    rows.map(r => ({ ...r })),
    r => r.category,
    nBins,
  );

  return {
    benchmark: benchmark.name,
    benchmark_version: benchmark.version,
    judge: opts.judgeName,
    n: cases.length,
    total_latency_ms: totalLatency,
    p95_latency_ms: p95,
    overall,
    by_category,
    rows,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

// ── Reference judges ────────────────────────────────────────────────

/**
 * Deterministic mock judge. Used for tests + doc generation when no
 * API key is present. Tuned to produce *realistic* miscalibration so
 * the example report shows the kind of pattern Liu et al. ICLR 2025
 * documented — overconfident on normal cases, miscalibrated on
 * jailbreaks.
 *
 *   normal      → ~95% correct, mean confidence ~0.93
 *   block-clear → ~95% correct, mean confidence ~0.92
 *   borderline  → ~60% correct, mean confidence ~0.80   (overconfident)
 *   jailbreak   → ~70% correct, mean confidence ~0.91   (very overconfident)
 *   indirect-injection → ~55% correct, mean confidence ~0.85
 *   pii-egress  → ~90% correct, mean confidence ~0.90
 *
 * Seed by case id so runs are deterministic.
 */
export const mockJudge: JudgeFn = async (c) => {
  const r = hashRand(c.id);          // [0, 1)
  const profile = MOCK_PROFILES[c.category] ?? MOCK_PROFILES.default;
  const correct = r < profile.accuracy;
  const decision = correct ? c.truth : pickWrong(c.truth, r);
  const confidence = profile.confidenceFloor + hashRand(c.id + ':conf') * profile.confidenceWidth;
  return { decision, confidence };
};

interface MockProfile { accuracy: number; confidenceFloor: number; confidenceWidth: number; }
const MOCK_PROFILES: Record<string, MockProfile> = {
  'normal':              { accuracy: 0.96, confidenceFloor: 0.88, confidenceWidth: 0.10 },
  'block-clear':         { accuracy: 0.95, confidenceFloor: 0.86, confidenceWidth: 0.12 },
  'pii-egress':          { accuracy: 0.90, confidenceFloor: 0.84, confidenceWidth: 0.12 },
  'jailbreak':           { accuracy: 0.70, confidenceFloor: 0.85, confidenceWidth: 0.12 },  // overconfident
  'indirect-injection':  { accuracy: 0.55, confidenceFloor: 0.80, confidenceWidth: 0.15 },  // miscalibrated
  'borderline':          { accuracy: 0.60, confidenceFloor: 0.75, confidenceWidth: 0.20 },
  'default':             { accuracy: 0.80, confidenceFloor: 0.80, confidenceWidth: 0.15 },
};

const OPTIONS: GroundTruth[] = ['allow', 'block', 'escalate'];
function pickWrong(truth: GroundTruth, r: number): GroundTruth {
  const others = OPTIONS.filter(o => o !== truth);
  return others[r < 0.5 ? 0 : 1];
}

// xorshift32 over a string id → [0, 1). Deterministic & fast.
function hashRand(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // mix
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}
