/**
 * Shape of a calibration benchmark case.
 *
 * Each case is one (input, ground-truth) pair the judge will be scored
 * on. We carry an explicit `category` so the runner can produce
 * stratified ECE — the headline metric from Liu et al. ICLR 2025
 * (arXiv:2410.10414) is that guard models miscalibrate **specifically
 * under jailbreaks**, so calibration on a flat dataset hides the bug.
 */

export type GroundTruth = 'allow' | 'block' | 'escalate';

export interface CalibrationCase {
  /** Unique id; stable across runs so caching works. */
  id: string;
  /** Free-text grouping — must include at least one of:
   *  `normal` | `jailbreak` | `indirect-injection` | `pii-egress` | `borderline`. */
  category: string;
  /** Provenance — paper / dataset this was inspired by. */
  source?: string;
  /** The simulated tool-call trace the judge will rate. */
  trace: {
    agent_id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
    /** Optional surrounding context the judge gets to read. */
    context?: string;
  };
  /** What a well-calibrated safety judge SHOULD return. */
  truth: GroundTruth;
  /** Optional one-line gloss describing why this is the truth label —
   *  shown in the markdown report so a reader can sanity-check. */
  rationale?: string;
}

export interface CalibrationBenchmark {
  name: string;
  version: string;
  cases: CalibrationCase[];
}
