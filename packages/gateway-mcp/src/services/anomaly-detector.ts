/**
 * Anomaly Detector — learning-based behavior deviation scoring
 *
 * Architecture:
 *   1. FeatureEncoder extracts 16-dim raw features from observation + profile
 *   2. Features are online-normalized via per-agent EWMA mean/variance
 *   3. Normalized features feed directly into an Isolation Forest
 *   4. IF learns what "normal" looks like — no hardcoded weights needed
 *   5. Per-agent adaptive thresholds (mean + K*sigma of score distribution)
 *   6. Human feedback (approve/reject) flows back to IF reservoir + score tracker
 *
 * Cold-start: weighted fallback from 9 legacy signal scores until IF has
 * enough samples (minForestSamples, default 30).
 *
 * Legacy 9-signal extractors remain as fallback and for explainability.
 */

import { AgentProfile, ScoreTracker } from './behavior-profile';
import { SlidingWindowStats } from './sliding-window';
import { IsolationForest, IsolationForestConfig } from './isolation-forest';
import { PPMModel } from './ppm';
import { FeatureEncoder, FeatureStats, RawObservation, FEATURE_DIM } from './feature-encoder';
import { Adwin } from './adwin';
import { MahalanobisScorer } from './mahalanobis';
import { ConformalCalibrator } from './conformal';
import { HalfSpaceTrees } from './half-space-trees';
import { ActiveAnomalyDiscovery, Feedback } from './aad';
import { AnomalyExplainer, AnomalyExplanation } from './anomaly-explainer';
import { TenantBaselineService } from './tenant-baseline';

// ── Types ───────────────────────────────────────────────────────────────────

export enum AnomalyType {
  TOOL_NEVER_SEEN      = 'tool_never_seen',
  TOOL_FREQUENCY_SPIKE = 'tool_frequency_spike',
  ARG_SHAPE_DRIFT      = 'arg_shape_drift',
  ARG_LENGTH_OUTLIER   = 'arg_length_outlier',
  TEMPORAL_ANOMALY     = 'temporal_anomaly',
  SEQUENCE_ANOMALY     = 'sequence_anomaly',
  COST_SPIKE           = 'cost_spike',
  RISK_ESCALATION      = 'risk_escalation',
  SESSION_BURST        = 'session_burst',
}

export interface AnomalySignal {
  type: AnomalyType;
  score: number;          // 0-1, higher = more anomalous
  zscore: number;         // standard deviations from mean
  detail: string;
  baseline_value: number;
  observed_value: number;
}

export type AnomalyDecision = 'pass' | 'flag' | 'escalate' | 'block';

export interface AnomalyResult {
  composite_score: number;   // 0-1, Isolation Forest or weighted fallback
  signals: AnomalySignal[];
  decision: AnomalyDecision;
  /** Which scoring method was used */
  scoring_method: 'isolation_forest' | 'weighted_fallback';
  /** Raw 16-dim feature vector (for debugging/logging) */
  feature_vector?: number[];
  /** Mahalanobis squared distance from the agent's mean (correlated-feature anomalies). */
  mahalanobis_score?: number;
  /** Tail probability under chi-square(d); small = anomalous. */
  mahalanobis_p_value?: number;
  /** Conformal p-value of the IF composite, calibrated against the
   *  sliding window of recent IF scores. Small = anomalous. The
   *  interpretation is fixed across model versions ("at most α% of
   *  normal calls fall below α"). */
  conformal_p_value?: number;
  /** True iff ADWIN flagged a behavioural drift on this call. Cleared
   *  on next call — this is an *event*, not a state. */
  drift_detected?: boolean;
  /** Magnitude of the most-recent drift cut (when drift_detected). */
  drift_magnitude?: number;
  /** Half-Space Trees streaming detector score (primary). */
  hst_score?: number;
  /** True iff AAD has incorporated enough operator feedback to
   *  influence the ensemble (>= minFeedbacks). When false the
   *  ensemble falls back to the raw IF/HST/Mahalanobis composite. */
  aad_active?: boolean;
  /** SHAP-style per-feature attribution + top-K contributors + a
   *  one-sentence English summary. Surfaced on the cockpit trace
   *  detail page so operators can see WHY a score was high. */
  explanation?: AnomalyExplanation;
}

export interface AnomalyThresholds {
  flag: number;      // default 0.3
  escalate: number;  // default 0.6
  block: number;     // default 0.85
}

export interface AnomalyWeights {
  [AnomalyType.TOOL_NEVER_SEEN]: number;
  [AnomalyType.TOOL_FREQUENCY_SPIKE]: number;
  [AnomalyType.ARG_SHAPE_DRIFT]: number;
  [AnomalyType.ARG_LENGTH_OUTLIER]: number;
  [AnomalyType.TEMPORAL_ANOMALY]: number;
  [AnomalyType.SEQUENCE_ANOMALY]: number;
  [AnomalyType.COST_SPIKE]: number;
  [AnomalyType.RISK_ESCALATION]: number;
  [AnomalyType.SESSION_BURST]: number;
}

export const DEFAULT_WEIGHTS: AnomalyWeights = {
  [AnomalyType.TOOL_NEVER_SEEN]:      0.20,
  [AnomalyType.TOOL_FREQUENCY_SPIKE]: 0.12,
  [AnomalyType.ARG_SHAPE_DRIFT]:      0.15,
  [AnomalyType.ARG_LENGTH_OUTLIER]:   0.10,
  [AnomalyType.TEMPORAL_ANOMALY]:     0.08,
  [AnomalyType.SEQUENCE_ANOMALY]:     0.15,
  [AnomalyType.COST_SPIKE]:           0.08,
  [AnomalyType.RISK_ESCALATION]:      0.07,
  [AnomalyType.SESSION_BURST]:        0.05,
};

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  flag: 0.3,
  escalate: 0.6,
  block: 0.85,
};

export interface ForestConfig {
  numTrees: number;
  sampleSize: number;
  minSamples: number;
}

export interface PPMConfig {
  maxOrder: number;
  surpriseScale: number;
}

const DEFAULT_FOREST_CONFIG: ForestConfig = {
  numTrees: 100,
  sampleSize: 256,
  minSamples: 30,
};

const DEFAULT_PPM_CONFIG: PPMConfig = {
  maxOrder: 4,
  surpriseScale: 3.0,
};

// ── Detector ────────────────────────────────────────────────────────────────

export class AnomalyDetector {
  private forests: Map<string, IsolationForest> = new Map();
  private ppmModels: Map<string, PPMModel> = new Map();
  private mahalanobis: Map<string, MahalanobisScorer> = new Map();
  private conformals: Map<string, ConformalCalibrator> = new Map();
  private adwins: Map<string, Adwin> = new Map();
  private hsts: Map<string, HalfSpaceTrees> = new Map();
  private aads: Map<string, ActiveAnomalyDiscovery> = new Map();
  private featureEncoder: FeatureEncoder;
  private forestConfig: ForestConfig;
  private ppmConfig: PPMConfig;
  private explainer = new AnomalyExplainer(3);

  constructor(
    private slidingWindow: SlidingWindowStats,
    private weights: AnomalyWeights = DEFAULT_WEIGHTS,
    private thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
    forestConfig?: Partial<ForestConfig>,
    ppmConfig?: Partial<PPMConfig>,
    /** Optional tenant-baseline service — when present, new agents
     *  seed their feature_stats from the tenant aggregate so the
     *  detector produces meaningful scores from call #1. */
    private tenantBaseline?: TenantBaselineService,
  ) {
    this.forestConfig = { ...DEFAULT_FOREST_CONFIG, ...forestConfig };
    this.ppmConfig = { ...DEFAULT_PPM_CONFIG, ...ppmConfig };
    this.featureEncoder = new FeatureEncoder(slidingWindow);
  }

  /**
   * Evaluate a tool call against an agent's behavioral profile.
   *
   * Primary path: 16-dim FeatureEncoder → Isolation Forest
   * Fallback:     9 legacy signal scores → weighted average (cold-start)
   */
  evaluate(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    profile: AgentProfile,
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW',
    costUsd: number = 0,
    /** Optional tenant id — when supplied + TenantBaselineService was
     *  wired into the constructor, new agents seed their feature_stats
     *  + Mahalanobis from the tenant baseline. Backward-compatible:
     *  omitting it preserves current cold-start behaviour. */
    orgId?: string,
  ): AnomalyResult {
    // Cold-start seed: if the profile has no featureStats yet AND the
    // tenant has an aggregated baseline AND the caller supplied orgId,
    // seed the agent's stats from the tenant aggregate. The Mahalanobis
    // mean inherits from the tenant baseline so d² ≠ 0 from call #1.
    if (orgId && this.tenantBaseline && (!profile.featureStats || profile.featureStats.n < 5)) {
      const baseline = this.tenantBaseline.getBaseline(orgId);
      if (baseline) {
        if (!profile.featureStats || profile.featureStats.n === 0) {
          profile.featureStats = {
            mean: baseline.mean.slice(),
            variance: baseline.variance.slice(),
            // Use a fractional n so the new agent's own samples quickly
            // dominate as they arrive (don't pretend we have full tenant
            // weight in the agent's own EWMA).
            n: 5,
          };
        }
        // Also seed Mahalanobis with the baseline mean — it normally
        // requires 20 samples before producing a score, so this skips
        // the silent period for the FIRST 20 calls of a new agent.
        const maha = this.getOrCreateMahalanobis(agentId, profile);
        if (maha.samples === 0) {
          // Inject the baseline as one "synthetic average" sample so
          // mean ≈ baseline.mean before the first real update.
          maha.update(baseline.mean);
        }
      }
    }
    // Always compute legacy signals for explainability
    const signals: AnomalySignal[] = [];
    signals.push(this.checkToolNovelty(toolName, profile));
    signals.push(this.checkFrequencySpike(agentId, toolName, profile));
    signals.push(this.checkArgShapeDrift(toolName, args, profile));
    signals.push(this.checkArgLengthOutlier(toolName, args, profile));
    signals.push(this.checkTemporalAnomaly(profile));
    signals.push(this.checkSequenceAnomaly(agentId, toolName, profile));
    signals.push(this.checkCostSpike(costUsd, profile));
    signals.push(this.checkRiskEscalation(agentId, profile));
    signals.push(this.checkSessionBurst(agentId, profile));

    // Get or create PPM model for this agent
    const ppm = this.getOrCreatePPM(agentId, profile);

    // Build raw observation for feature encoder
    const obs: RawObservation = {
      toolName,
      args,
      riskLevel,
      costUsd,
      timestampMs: Date.now(),
    };

    // Extract 16-dim raw features
    const rawFeatures = this.featureEncoder.extractRaw(agentId, obs, profile, ppm);

    // Update per-agent feature normalization stats
    profile.featureStats = FeatureEncoder.updateFeatureStats(profile.featureStats, rawFeatures);

    // Get normalized features for IF scoring
    const normalizedFeatures = this.featureEncoder.encode(agentId, obs, profile, ppm);

    // Composite scoring: IF on 16-dim features or weighted fallback
    const forest = this.getOrCreateForest(agentId, profile);
    let composite: number;
    let scoringMethod: 'isolation_forest' | 'weighted_fallback';

    if (forest.isTrained && forest.sampleCount >= this.forestConfig.minSamples) {
      // Check dimension compatibility — reset forest if dims changed
      if (forest.featureDims > 0 && forest.featureDims !== FEATURE_DIM) {
        forest.reset();
      }

      if (forest.isTrained) {
        composite = forest.score(normalizedFeatures);
        scoringMethod = 'isolation_forest';
      } else {
        composite = this.weightedFallback(signals);
        scoringMethod = 'weighted_fallback';
      }
    } else {
      composite = this.weightedFallback(signals);
      scoringMethod = 'weighted_fallback';
    }

    // Incrementally train the forest on normalized features
    forest.addSample(normalizedFeatures);

    // Update PPM model for next sequence prediction
    ppm.update(toolName);

    // ── Second-opinion + calibration + drift ─────────────────────────────
    // Mahalanobis catches anomalies that live in correlated feature
    // combinations (IF's random axis-aligned splits can miss those).
    const mahalanobis = this.getOrCreateMahalanobis(agentId, profile);
    let mahalanobisScore: number | undefined;
    let mahalanobisP: number | undefined;
    if (normalizedFeatures.length === FEATURE_DIM) {
      mahalanobisScore = mahalanobis.score(normalizedFeatures);
      if (mahalanobis.samples >= 20) {
        mahalanobisP = mahalanobis.pValue(mahalanobisScore);
      }
      mahalanobis.update(normalizedFeatures);
    }

    // Half-Space Trees — purpose-built streaming detector (Tan 2011).
    // Better than IF on drifting streams because it doesn't rely on
    // a reservoir-then-rebuild rhythm; mass counters refresh per
    // window. We use it as a co-primary signal alongside IF.
    const hst = this.getOrCreateHst(agentId, profile);
    const hstScore = hst.score(normalizedFeatures);
    hst.update(normalizedFeatures);

    // AAD reweighting — when the operator has marked enough FP/TP
    // examples, the [IF, HST, Mahalanobis] triple gets multiplied
    // through a learned weight vector. Before that the call is a
    // safe pass-through (unweighted mean).
    const aad = this.getOrCreateAad(agentId, profile);
    const aadOut = aad.reweight([
      Math.max(0, Math.min(1, composite)),
      Math.max(0, Math.min(1, hstScore)),
      Math.max(0, Math.min(1, mahalanobisP !== undefined ? 1 - mahalanobisP : 0)),
    ]);

    // Ensemble: AAD-reweighted when active, else robust max over the
    // three signals. AAD's contribution is monotone in the per-
    // detector scores (weights are non-negative), so the worst case
    // is "noisier but safe" — never less anomalous than raw IF.
    let ensembleScore: number;
    if (aadOut.usedFeedback) {
      ensembleScore = aadOut.score;
    } else {
      const mScore = mahalanobisP !== undefined ? 1 - mahalanobisP : 0;
      ensembleScore = Math.max(composite, hstScore, mScore);
    }

    // Conformal calibration: turn raw IF score into a streaming p-value
    // against the agent's own score history. Used by the policy layer
    // for "p < 0.01"-style thresholds — operationally meaningful.
    const conformal = this.getOrCreateConformal(agentId, profile);
    const conformalP = conformal.pValue(composite);
    conformal.addScore(composite);

    // ADWIN drift detection on the composite. When drift fires, we
    // reset the feature-normalization stats (so the EWMA learns the
    // new normal fast) but KEEP the forest reservoir — the forest
    // already self-adapts via reservoir sampling. Resetting feature
    // stats prevents the post-shift "everything looks anomalous" storm.
    const adwin = this.getOrCreateAdwin(agentId, profile);
    const adwinResult = adwin.update(composite);
    if (adwinResult.drift) {
      profile.featureStats = undefined;
      profile.driftCount = (profile.driftCount ?? 0) + 1;
      profile.lastDriftAt = new Date().toISOString();
    }

    // Update per-agent score tracker for adaptive thresholds
    profile.scoreTracker = AnomalyDetector.updateScoreTracker(profile.scoreTracker, ensembleScore);

    // Store updated state back to profile for persistence
    profile.forestState        = forest.serialize();
    profile.ppmState           = ppm.serialize();
    profile.mahalanobisState   = mahalanobis.serialize();
    profile.conformalState     = conformal.serialize();
    profile.adwinState         = adwin.serialize();
    profile.hstState           = hst.serialize();
    profile.aadState           = aad.serialize();

    // Use adaptive thresholds if we have enough score history
    const effectiveThresholds = this.adaptiveThresholds(profile.scoreTracker);
    const decision = this.decide(ensembleScore, effectiveThresholds);

    // SHAP-style per-feature attribution (sub-ms; OK on hot path)
    let explanation: AnomalyExplanation | undefined;
    if (normalizedFeatures.length === FEATURE_DIM) {
      try {
        explanation = this.explainer.explain({
          normalized: normalizedFeatures,
          rawFeatures,
          forest,
          hst,
          maha: mahalanobis,
          ensembleScore,
          // Pass AAD weights when available — explainer rescales contributions
          // to match how the ensemble actually weighted detectors.
          detectorWeights: aadOut.usedFeedback ? [1, 1, 1] : undefined,
        });
      } catch {
        // Explanation is a best-effort surface; never block evaluation.
      }
    }

    return {
      composite_score: Math.round(ensembleScore * 1000) / 1000,
      signals: signals.filter(s => s.score > 0),
      decision,
      scoring_method: scoringMethod,
      feature_vector: rawFeatures,
      mahalanobis_score:   mahalanobisScore,
      mahalanobis_p_value: mahalanobisP,
      conformal_p_value:   conformalP,
      drift_detected:      adwinResult.drift,
      drift_magnitude:     adwinResult.cutMagnitude,
      hst_score:           hstScore,
      aad_active:          aadOut.usedFeedback,
      explanation,
    };
  }

  // ── Feedback Loop ─────────────────────────────────────────────────────────

  /**
   * Ingest human feedback (approve/reject) to tune the model.
   *
   * - approve (false positive): add the feature vector as a "normal" sample
   *   to the IF reservoir with extra weight, lowering future scores for
   *   similar observations. Also adjusts score tracker downward.
   *
   * - reject (true positive): remove similar samples from reservoir to
   *   ensure the forest keeps flagging this pattern. Adjusts score tracker
   *   upward.
   */
  ingestFeedback(
    agentId: string,
    profile: AgentProfile,
    featureVector: number[],
    approved: boolean,
  ): void {
    const forest = this.getOrCreateForest(agentId, profile);
    const hst    = this.getOrCreateHst(agentId, profile);
    const maha   = this.getOrCreateMahalanobis(agentId, profile);
    const aad    = this.getOrCreateAad(agentId, profile);

    // Recompute the per-detector contribution for this point so AAD
    // can learn which detectors are aligned with the operator's label.
    const ifScore = forest.isTrained ? forest.score(featureVector) : 0;
    const hstScore = hst.isWarmed ? hst.score(featureVector) : 0;
    const mScore = maha.samples >= 20 ? 1 - maha.pValue(maha.score(featureVector)) : 0;
    aad.feedback([ifScore, hstScore, mScore], approved ? 'fp' : 'tp');

    if (approved) {
      // False positive: reinforce as normal by adding multiple copies
      // This biases the reservoir toward this pattern, lowering its anomaly score
      for (let i = 0; i < 3; i++) {
        forest.addSample(featureVector);
        hst.update(featureVector);   // HST also benefits from re-weighting toward "this was normal"
      }
      // Nudge score tracker down (this was over-flagged)
      if (profile.scoreTracker && profile.scoreTracker.n > 0) {
        profile.scoreTracker = AnomalyDetector.updateScoreTracker(
          profile.scoreTracker, profile.scoreTracker.mean * 0.8,
        );
      }
    } else {
      // True positive: confirmed anomaly — nudge score tracker up
      if (profile.scoreTracker) {
        profile.scoreTracker = AnomalyDetector.updateScoreTracker(
          profile.scoreTracker, 1.0,
        );
      }
    }

    // Persist updated state
    profile.forestState = forest.serialize();
    profile.hstState    = hst.serialize();
    profile.aadState    = aad.serialize();
  }

  // ── Adaptive Thresholds ───────────────────────────────────────────────────

  /**
   * Compute per-agent thresholds from score distribution.
   * flag     = mean + 2*sigma
   * escalate = mean + 3*sigma
   * block    = mean + 4*sigma
   *
   * Falls back to global defaults if insufficient history.
   * Thresholds are clamped to sane ranges.
   */
  adaptiveThresholds(tracker?: ScoreTracker): AnomalyThresholds {
    if (!tracker || tracker.n < 50) {
      return this.thresholds; // Use global defaults during cold-start
    }

    const std = Math.sqrt(tracker.variance + 1e-8);
    return {
      flag:     clamp(tracker.mean + 2 * std, 0.15, 0.5),
      escalate: clamp(tracker.mean + 3 * std, 0.4,  0.8),
      block:    clamp(tracker.mean + 4 * std, 0.6,  0.95),
    };
  }

  /**
   * Update score tracker with a new anomaly score (EWMA).
   */
  static updateScoreTracker(
    tracker: ScoreTracker | undefined,
    score: number,
    alpha = 0.02,
  ): ScoreTracker {
    if (!tracker) {
      return { mean: score, variance: 0, n: 1 };
    }

    const effectiveAlpha = Math.min(alpha, 2 / (tracker.n + 1));
    const delta = score - tracker.mean;
    const mean = tracker.mean + effectiveAlpha * delta;
    const variance = (1 - effectiveAlpha) * tracker.variance + effectiveAlpha * delta * delta;

    return { mean, variance, n: tracker.n + 1 };
  }

  // ── Isolation Forest Management ───────────────────────────────────────────

  private getOrCreateForest(agentId: string, profile: AgentProfile): IsolationForest {
    let forest = this.forests.get(agentId);
    if (forest) return forest;

    // Try to restore from profile
    if (profile.forestState) {
      try {
        forest = IsolationForest.deserialize(profile.forestState);
        // Check dimension compatibility
        if (forest.featureDims > 0 && forest.featureDims !== FEATURE_DIM) {
          forest.reset();
        }
        this.forests.set(agentId, forest);
        return forest;
      } catch { /* fall through to create new */ }
    }

    // Create new forest
    forest = new IsolationForest({
      numTrees: this.forestConfig.numTrees,
      sampleSize: this.forestConfig.sampleSize,
    });

    if (profile.forestSamples && profile.forestSamples.length > 0) {
      // Check dimension compatibility for legacy samples
      if (profile.forestSamples[0].length === FEATURE_DIM) {
        forest.fit(profile.forestSamples);
      }
    }

    this.forests.set(agentId, forest);
    return forest;
  }

  // ── Mahalanobis / Conformal / ADWIN Management ───────────────────────────
  // Each per-agent state lives in the same restore-from-profile pattern as
  // the IF and PPM models. Hot-path lookups are O(1) via the Maps.

  private getOrCreateMahalanobis(agentId: string, profile: AgentProfile): MahalanobisScorer {
    let s = this.mahalanobis.get(agentId);
    if (s) return s;
    if (profile.mahalanobisState) {
      try { s = MahalanobisScorer.deserialize(profile.mahalanobisState); }
      catch { /* corrupted snapshot — fall through */ }
    }
    if (!s) s = new MahalanobisScorer({ shrinkage: 0.10, minSamples: 20 });
    this.mahalanobis.set(agentId, s);
    return s;
  }

  private getOrCreateConformal(agentId: string, profile: AgentProfile): ConformalCalibrator {
    let c = this.conformals.get(agentId);
    if (c) return c;
    if (profile.conformalState) {
      try { c = ConformalCalibrator.deserialize(profile.conformalState); }
      catch { /* corrupted snapshot — fall through */ }
    }
    if (!c) c = new ConformalCalibrator({ windowSize: 512, minSamples: 30 });
    this.conformals.set(agentId, c);
    return c;
  }

  private getOrCreateAdwin(agentId: string, profile: AgentProfile): Adwin {
    let a = this.adwins.get(agentId);
    if (a) return a;
    if (profile.adwinState) {
      try { a = Adwin.deserialize(profile.adwinState); }
      catch { /* corrupted snapshot — fall through */ }
    }
    if (!a) a = new Adwin({ delta: 0.002, minWindow: 50 });
    this.adwins.set(agentId, a);
    return a;
  }

  private getOrCreateHst(agentId: string, profile: AgentProfile): HalfSpaceTrees {
    let h = this.hsts.get(agentId);
    if (h) return h;
    if (profile.hstState) {
      try { h = HalfSpaceTrees.deserialize(profile.hstState); }
      catch { /* corrupted snapshot */ }
    }
    if (!h) h = new HalfSpaceTrees({ numTrees: 25, depth: 8, windowSize: 256, minSamples: 30 });
    this.hsts.set(agentId, h);
    return h;
  }

  private getOrCreateAad(agentId: string, profile: AgentProfile): ActiveAnomalyDiscovery {
    let a = this.aads.get(agentId);
    if (a) return a;
    if (profile.aadState) {
      try { a = ActiveAnomalyDiscovery.deserialize(profile.aadState); }
      catch { /* corrupted snapshot */ }
    }
    if (!a) a = new ActiveAnomalyDiscovery({ numTrees: 25, minFeedbacks: 8 });
    this.aads.set(agentId, a);
    return a;
  }

  // ── PPM Model Management ─────────────────────────────────────────────────

  private getOrCreatePPM(agentId: string, profile: AgentProfile): PPMModel {
    let ppm = this.ppmModels.get(agentId);
    if (ppm) return ppm;

    // Try to restore from profile
    if (profile.ppmState) {
      try {
        ppm = PPMModel.deserialize(profile.ppmState);
        this.ppmModels.set(agentId, ppm);
        return ppm;
      } catch { /* fall through */ }
    }

    // Create new PPM model
    ppm = new PPMModel(this.ppmConfig.maxOrder);
    this.ppmModels.set(agentId, ppm);
    return ppm;
  }

  // ── Individual Feature Extractors (legacy, for explainability + fallback) ─

  private checkToolNovelty(toolName: string, profile: AgentProfile): AnomalySignal {
    const known = profile.knownTools.includes(toolName);
    return {
      type: AnomalyType.TOOL_NEVER_SEEN,
      score: known ? 0 : 1.0,
      zscore: known ? 0 : Infinity,
      detail: known ? 'known tool' : `tool "${toolName}" never seen in baseline`,
      baseline_value: profile.knownTools.length,
      observed_value: known ? 1 : 0,
    };
  }

  private checkFrequencySpike(
    agentId: string, toolName: string, profile: AgentProfile,
  ): AnomalySignal {
    const dist = profile.toolDistribution[toolName];
    if (!dist) {
      return this.noDataSignal(AnomalyType.TOOL_FREQUENCY_SPIKE);
    }

    const baselinePerMin = dist.count / (profile.windowDays * 24 * 60);
    const currentPerMin = this.slidingWindow.getToolFrequency(agentId, toolName, 300);

    if (baselinePerMin === 0) {
      return this.noDataSignal(AnomalyType.TOOL_FREQUENCY_SPIKE);
    }

    const ratio = currentPerMin / baselinePerMin;
    const zscore = Math.max(0, ratio - 1);
    const score = sigmoid(zscore - 2);

    return {
      type: AnomalyType.TOOL_FREQUENCY_SPIKE,
      score,
      zscore,
      detail: `${toolName} rate ${currentPerMin.toFixed(2)}/min vs baseline ${baselinePerMin.toFixed(4)}/min (${ratio.toFixed(1)}x)`,
      baseline_value: baselinePerMin,
      observed_value: currentPerMin,
    };
  }

  private checkArgShapeDrift(
    toolName: string, args: Record<string, unknown>, profile: AgentProfile,
  ): AnomalySignal {
    const fp = profile.argumentFingerprints[toolName];
    if (!fp || fp.knownKeySets.length === 0) {
      return this.noDataSignal(AnomalyType.ARG_SHAPE_DRIFT);
    }

    const currentKeys = Object.keys(args).sort().join(',');
    if (fp.knownKeySets.includes(currentKeys)) {
      return {
        type: AnomalyType.ARG_SHAPE_DRIFT,
        score: 0,
        zscore: 0,
        detail: 'argument shape matches known pattern',
        baseline_value: fp.knownKeySets.length,
        observed_value: 1,
      };
    }

    const currentKeySet = new Set(Object.keys(args));
    let bestJaccard = 0;
    for (const ksStr of fp.knownKeySets) {
      const knownKeys = new Set(ksStr.split(',').filter(Boolean));
      const intersection = new Set([...currentKeySet].filter(k => knownKeys.has(k)));
      const union = new Set([...currentKeySet, ...knownKeys]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 1;
      if (jaccard > bestJaccard) bestJaccard = jaccard;
    }

    const score = 1 - bestJaccard;
    return {
      type: AnomalyType.ARG_SHAPE_DRIFT,
      score,
      zscore: score > 0 ? 1 / bestJaccard : 0,
      detail: `argument keys differ from baseline (jaccard=${bestJaccard.toFixed(2)})`,
      baseline_value: bestJaccard,
      observed_value: 1 - bestJaccard,
    };
  }

  private checkArgLengthOutlier(
    toolName: string, args: Record<string, unknown>, profile: AgentProfile,
  ): AnomalySignal {
    const fp = profile.argumentFingerprints[toolName];
    if (!fp || fp.stdArgLength === 0) {
      return this.noDataSignal(AnomalyType.ARG_LENGTH_OUTLIER);
    }

    const observed = JSON.stringify(args).length;
    const zscore = Math.abs(observed - fp.avgArgLength) / Math.max(fp.stdArgLength, 1);
    const score = sigmoid(zscore - 3);

    return {
      type: AnomalyType.ARG_LENGTH_OUTLIER,
      score,
      zscore,
      detail: `arg length ${observed} vs baseline μ=${fp.avgArgLength.toFixed(0)} σ=${fp.stdArgLength.toFixed(0)} (z=${zscore.toFixed(1)})`,
      baseline_value: fp.avgArgLength,
      observed_value: observed,
    };
  }

  private checkTemporalAnomaly(profile: AgentProfile): AnomalySignal {
    const hour = new Date().getUTCHours();
    const totalCalls = profile.temporalPattern.hourDistribution.reduce((a, b) => a + b, 0);
    if (totalCalls === 0) {
      return this.noDataSignal(AnomalyType.TEMPORAL_ANOMALY);
    }

    const density = profile.temporalPattern.hourDistribution[hour] / totalCalls;
    let score = 0;
    if (density < 0.005) score = 0.9;
    else if (density < 0.01) score = 0.7;
    else if (density < 0.02) score = 0.3;

    return {
      type: AnomalyType.TEMPORAL_ANOMALY,
      score,
      zscore: density > 0 ? (1 / 24 - density) / (1 / 24) : 10,
      detail: `hour ${hour} UTC has ${(density * 100).toFixed(1)}% of baseline traffic`,
      baseline_value: density,
      observed_value: 1,
    };
  }

  /**
   * Sequence anomaly — uses PPM-C variable-order Markov chain
   * instead of simple bigram transition matrix.
   */
  private checkSequenceAnomaly(
    agentId: string, toolName: string, profile: AgentProfile,
  ): AnomalySignal {
    const prevTool = this.slidingWindow.getLastTool(agentId);
    if (!prevTool) {
      return this.noDataSignal(AnomalyType.SEQUENCE_ANOMALY);
    }

    // Try PPM model first
    const ppm = this.getOrCreatePPM(agentId, profile);
    if (ppm.alphabetSize >= 2) {
      const prob = ppm.predict(toolName);
      const surprise = ppm.surprise(toolName);
      const score = 1 - Math.exp(-surprise / this.ppmConfig.surpriseScale);

      return {
        type: AnomalyType.SEQUENCE_ANOMALY,
        score: Math.min(score, 1.0),
        zscore: surprise,
        detail: `PPM surprise=${surprise.toFixed(2)} prob=${(prob * 100).toFixed(1)}% context=[${ppm.getContext().slice(-3).join(',')}]→${toolName}`,
        baseline_value: prob,
        observed_value: surprise,
      };
    }

    // Fallback to bigram if PPM has no data yet
    const transitions = profile.transitionMatrix[prevTool];
    if (!transitions) {
      return {
        type: AnomalyType.SEQUENCE_ANOMALY,
        score: 0.8,
        zscore: 5,
        detail: `transition ${prevTool} → ${toolName}: source tool has no baseline transitions`,
        baseline_value: 0,
        observed_value: 1,
      };
    }

    const prob = transitions[toolName] ?? 0;
    const score = prob === 0 ? 1.0 : Math.max(0, 1 - prob * 3);

    return {
      type: AnomalyType.SEQUENCE_ANOMALY,
      score,
      zscore: prob > 0 ? (1 - prob) / Math.max(prob, 0.01) : 10,
      detail: `bigram ${prevTool} → ${toolName}: baseline probability ${(prob * 100).toFixed(1)}%`,
      baseline_value: prob,
      observed_value: prob === 0 ? 0 : 1,
    };
  }

  private checkCostSpike(costUsd: number, profile: AgentProfile): AnomalySignal {
    const { meanCostUsd, stdCostUsd } = profile.costBaseline;
    if (meanCostUsd === 0 && stdCostUsd === 0) {
      return this.noDataSignal(AnomalyType.COST_SPIKE);
    }

    const zscore = Math.abs(costUsd - meanCostUsd) / Math.max(stdCostUsd, 0.0001);
    const score = sigmoid(zscore - 3);

    return {
      type: AnomalyType.COST_SPIKE,
      score,
      zscore,
      detail: `cost $${costUsd.toFixed(4)} vs baseline μ=$${meanCostUsd.toFixed(4)} σ=$${stdCostUsd.toFixed(4)}`,
      baseline_value: meanCostUsd,
      observed_value: costUsd,
    };
  }

  private checkRiskEscalation(agentId: string, profile: AgentProfile): AnomalySignal {
    const baselineHighRate = profile.riskDistribution.HIGH + profile.riskDistribution.CRITICAL;
    const recentHighRate = this.slidingWindow.getHighRiskRate(agentId, 600);

    if (baselineHighRate === 0 && recentHighRate === 0) {
      return {
        type: AnomalyType.RISK_ESCALATION,
        score: 0,
        zscore: 0,
        detail: 'no high-risk calls in baseline or recent window',
        baseline_value: 0,
        observed_value: 0,
      };
    }

    if (baselineHighRate < 0.01 && recentHighRate > 0) {
      return {
        type: AnomalyType.RISK_ESCALATION,
        score: Math.min(recentHighRate * 2, 1.0),
        zscore: 10,
        detail: `recent high-risk rate ${(recentHighRate * 100).toFixed(0)}% vs baseline ${(baselineHighRate * 100).toFixed(1)}%`,
        baseline_value: baselineHighRate,
        observed_value: recentHighRate,
      };
    }

    const ratio = recentHighRate / Math.max(baselineHighRate, 0.001);
    const score = ratio > 3 ? Math.min((ratio - 3) / 7, 1.0) : 0;

    return {
      type: AnomalyType.RISK_ESCALATION,
      score,
      zscore: ratio,
      detail: `recent high-risk rate ${(recentHighRate * 100).toFixed(0)}% vs baseline ${(baselineHighRate * 100).toFixed(1)}% (${ratio.toFixed(1)}x)`,
      baseline_value: baselineHighRate,
      observed_value: recentHighRate,
    };
  }

  private checkSessionBurst(agentId: string, profile: AgentProfile): AnomalySignal {
    const recentCount = this.slidingWindow.getCallCount(agentId, 60);
    const baselinePerMin = profile.traceCount / (profile.windowDays * 24 * 60);

    if (baselinePerMin === 0) {
      return this.noDataSignal(AnomalyType.SESSION_BURST);
    }

    const ratio = recentCount / baselinePerMin;
    const zscore = Math.max(0, ratio - 1);
    const score = sigmoid(zscore - 3);

    return {
      type: AnomalyType.SESSION_BURST,
      score,
      zscore,
      detail: `${recentCount} calls/min vs baseline ${baselinePerMin.toFixed(2)}/min (${ratio.toFixed(1)}x)`,
      baseline_value: baselinePerMin,
      observed_value: recentCount,
    };
  }

  // ── Scoring ─────────────────────────────────────────────────────────────

  /** Weighted average fallback for cold-start (< minSamples in forest) */
  private weightedFallback(signals: AnomalySignal[]): number {
    let weightSum = 0;
    let scoreSum = 0;
    for (const signal of signals) {
      const w = this.weights[signal.type];
      if (signal.score > 0 || signal.zscore !== 0) {
        scoreSum += signal.score * w;
        weightSum += w;
      } else {
        if (signal.detail !== 'insufficient_data') {
          weightSum += w;
        }
      }
    }
    return weightSum > 0 ? scoreSum / weightSum : 0;
  }

  private decide(composite: number, thresholds?: AnomalyThresholds): AnomalyDecision {
    const t = thresholds ?? this.thresholds;
    if (composite >= t.block) return 'block';
    if (composite >= t.escalate) return 'escalate';
    if (composite >= t.flag) return 'flag';
    return 'pass';
  }

  private noDataSignal(type: AnomalyType): AnomalySignal {
    return {
      type,
      score: 0,
      zscore: 0,
      detail: 'insufficient_data',
      baseline_value: 0,
      observed_value: 0,
    };
  }
}

// ── Math ────────────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
