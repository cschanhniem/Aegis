/**
 * Expected Calibration Error (ECE) + reliability-diagram bins.
 *
 * Implements the standard Guo et al. 2017 binning estimator that
 * essentially every "calibration of guard models" paper uses
 * (Liu et al. ICLR 2025, arXiv:2410.10414 §3.1 is the direct reference
 * for AEGIS's reporting).
 *
 *   ECE = sum_b  (|B_b| / N) * | acc(B_b) - conf(B_b) |
 *
 * For an N-class judge AEGIS treats the *predicted* class's confidence
 * as the calibration probability; correctness = predicted-class equals
 * ground-truth class. (This is the standard reduction for ECE on
 * multi-class problems — see Guo et al. §2.5.)
 *
 * Public API is two functions with no I/O — pure math, fully unit-
 * testable, no model calls.
 */

export interface Prediction {
  /** Model's predicted class (e.g. "block" / "allow" / 1..5 integer). */
  predicted: string | number;
  /** Self-reported confidence in [0, 1] for the predicted class. */
  confidence: number;
  /** Ground-truth class — same domain as `predicted`. */
  truth: string | number;
}

export interface ReliabilityBin {
  binIndex: number;
  /** Range [lo, hi). Last bin includes 1.0. */
  lo: number;
  hi: number;
  /** Sample count in this bin. */
  count: number;
  /** Mean predicted confidence within the bin. */
  meanConfidence: number;
  /** Empirical accuracy within the bin. */
  accuracy: number;
}

export interface CalibrationResult {
  /** Expected Calibration Error in [0, 1]. */
  ece: number;
  /** Maximum Calibration Error across non-empty bins. */
  mce: number;
  /** Overall accuracy across all samples. */
  accuracy: number;
  /** Mean confidence across all samples. */
  meanConfidence: number;
  /** Brier score (multi-class generalisation collapsed to one-vs-rest on predicted class). */
  brier: number;
  /** Number of samples. */
  n: number;
  /** Reliability bins, ascending confidence. */
  bins: ReliabilityBin[];
}

/**
 * Build the reliability bins + headline metrics.
 *
 * @param predictions  raw predictions
 * @param nBins        number of equal-width confidence bins (default 10)
 */
export function calibrate(
  predictions: Prediction[],
  nBins: number = 10,
): CalibrationResult {
  if (predictions.length === 0) {
    return {
      ece: 0, mce: 0, accuracy: 0, meanConfidence: 0, brier: 0, n: 0, bins: [],
    };
  }
  if (nBins < 2 || !Number.isInteger(nBins)) {
    throw new Error(`nBins must be an integer >= 2 (got ${nBins})`);
  }

  // Validate inputs in one pass.
  for (const p of predictions) {
    if (typeof p.confidence !== 'number' || !Number.isFinite(p.confidence)) {
      throw new Error(`non-numeric confidence: ${JSON.stringify(p)}`);
    }
    if (p.confidence < 0 || p.confidence > 1) {
      throw new Error(`confidence out of [0,1]: ${p.confidence}`);
    }
  }

  // Bucket each prediction into a bin. The last bin includes confidence == 1.
  const bins: { hits: number; conf: number; count: number }[] = Array.from(
    { length: nBins },
    () => ({ hits: 0, conf: 0, count: 0 }),
  );
  for (const p of predictions) {
    const raw = Math.floor(p.confidence * nBins);
    const idx = raw === nBins ? nBins - 1 : raw;
    bins[idx].count += 1;
    bins[idx].conf  += p.confidence;
    if (p.predicted === p.truth) bins[idx].hits += 1;
  }

  // ECE + MCE.
  const n = predictions.length;
  let weightedGap = 0;
  let maxGap = 0;
  const reliabilityBins: ReliabilityBin[] = bins.map((b, i) => {
    const lo = i / nBins;
    const hi = (i + 1) / nBins;
    const meanConf = b.count > 0 ? b.conf / b.count : 0;
    const acc = b.count > 0 ? b.hits / b.count : 0;
    if (b.count > 0) {
      const gap = Math.abs(acc - meanConf);
      weightedGap += (b.count / n) * gap;
      if (gap > maxGap) maxGap = gap;
    }
    return {
      binIndex: i,
      lo, hi,
      count: b.count,
      meanConfidence: meanConf,
      accuracy: acc,
    };
  });

  // Accuracy, mean confidence, Brier (one-vs-rest on predicted class).
  let totalHits = 0;
  let totalConf = 0;
  let brierSum  = 0;
  for (const p of predictions) {
    const correct = p.predicted === p.truth ? 1 : 0;
    totalHits += correct;
    totalConf += p.confidence;
    brierSum  += (p.confidence - correct) * (p.confidence - correct);
  }

  return {
    ece: weightedGap,
    mce: maxGap,
    accuracy: totalHits / n,
    meanConfidence: totalConf / n,
    brier: brierSum / n,
    n,
    bins: reliabilityBins,
  };
}

/**
 * Slice a list of predictions by a label-extracting function and run
 * calibrate() per slice. Used to produce jailbreak-stratified
 * calibration (the headline finding from Liu et al. ICLR 2025).
 */
export function calibrateStratified<P extends Prediction>(
  predictions: P[],
  by: (p: P) => string,
  nBins: number = 10,
): Record<string, CalibrationResult> {
  const groups: Record<string, P[]> = {};
  for (const p of predictions) {
    const key = by(p);
    (groups[key] ??= []).push(p);
  }
  const out: Record<string, CalibrationResult> = {};
  for (const [k, ps] of Object.entries(groups)) out[k] = calibrate(ps, nBins);
  return out;
}

/**
 * ASCII reliability diagram for terminal / markdown output. Each bin
 * rendered as confidence vs accuracy bars side-by-side.
 *
 *   bin 0.0–0.1 | conf ▓▓░░░░░░░░ 0.05 | acc  ▓░░░░░░░░░ 0.02 |  n=3
 *
 * Calling code can render the same `bins` array however it likes —
 * this helper just gives a copy-paste-friendly text form.
 */
export function renderReliabilityAscii(
  bins: ReliabilityBin[],
  barWidth: number = 12,
): string {
  const lines = bins.map(b => {
    const confBar = bar(b.meanConfidence, barWidth);
    const accBar  = bar(b.accuracy,        barWidth);
    return `  ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | conf ${confBar} ${b.meanConfidence.toFixed(2)} | acc ${accBar} ${b.accuracy.toFixed(2)} | n=${b.count}`;
  });
  return lines.join('\n');
}

function bar(v: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, v)) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}
