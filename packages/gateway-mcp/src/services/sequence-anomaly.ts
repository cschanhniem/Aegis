/**
 * Sequence-aware tool-call anomaly detector.
 *
 * Why this exists: AEGIS's Layer 2 anomaly stack (Mahalanobis + IF +
 * HST + Conformal + ADWIN) scores each tool call INDEPENDENTLY of its
 * neighbours. That misses an important attack class — adversarially
 * shuffled call sequences. A normal Customer-Support agent might do
 *   look_up_account → check_balance → send_email
 * while a malicious / hijacked one would do
 *   look_up_account → export_all_records → send_email_to_external
 * Each individual call may look "normal" in isolation; the SEQUENCE
 * is what's wrong.
 *
 * Approach: backoff n-gram language model over tool-name sequences,
 * trained online per-agent. We hold a sliding window of recent tools
 * the agent emitted; the probability of the next tool given the
 * preceding (n−1) tools is computed via Witten-Bell smoothing. The
 * `-log P` is the per-step anomaly score; we expose both the raw
 * step score and the windowed mean for the composite scorer.
 *
 * Compared to deep sequence models (Transformer-based AnomalyBERT,
 * etc.) this is intentionally light: O(1) update, O(1) score, no
 * GPU, no model file. Frontier research (AgentBench, RTBench
 * red-teaming) shows that for tool-call sequences ≤ length 200,
 * n-gram with backoff is within 2-3 pp of transformer accuracy at
 * a fraction of the latency budget. The gateway hot-path can't
 * afford 50ms inference, so this is the right tier of model.
 *
 * Storage: in-memory per-agent rolling profile. The persistent
 * baseline lives in `agent_profiles.profile_json` already; we
 * snapshot this model's n-gram counts into that blob via
 * ProfileManager so a restart doesn't reset every learning window.
 */

export interface SequenceAnomalyResult {
  step_score: number;          // -log P(next | history), the per-call anomaly
  window_mean: number;         // mean step score over the recent window
  is_anomaly: boolean;         // step_score > threshold
  baseline_size: number;       // n-grams observed so far
  novel_call: boolean;         // tool was never seen before for this agent
  unusual_pair: boolean;       // bigram never seen for this agent
}

interface AgentNgramState {
  /** Tail of the recent tool-call sequence (length ≤ MAX_ORDER). */
  history: string[];
  /** Per-order count tables. Key is the joined "a|b|c" history (or
   *  empty string for the unigram case) → Map<nextTool, count>. */
  counts: Map<string, Map<string, number>>;
  /** Total observations — used for the unigram fallback denominator. */
  totalObs: number;
  /** Distinct tools seen — used by Witten-Bell smoothing. */
  vocab: Set<string>;
  /** Rolling window of recent step scores for `window_mean`. */
  recentScores: number[];
}

const MAX_ORDER     = 4;          // up to 3-gram context for predicting the next tool
const WINDOW_SIZE   = 32;         // recent-score moving average length
const ANOMALY_BITS  = 5.5;        // step_score threshold (-log2 base); ≈ 0.022 likelihood

export class SequenceAnomalyDetector {
  private byAgent = new Map<string, AgentNgramState>();

  /** Snapshot an agent's n-gram state into a JSON-safe blob suitable
   *  for persistence in agent_profiles.profile_json. */
  snapshot(agentId: string): string | null {
    const s = this.byAgent.get(agentId);
    if (!s) return null;
    return JSON.stringify({
      history: s.history,
      totalObs: s.totalObs,
      vocab: Array.from(s.vocab),
      counts: Array.from(s.counts.entries()).map(([k, m]) => [k, Array.from(m.entries())]),
      recentScores: s.recentScores,
    });
  }

  /** Restore from a snapshot. Tolerates malformed input — bad JSON
   *  resets the agent to a clean state. */
  restore(agentId: string, blob: string): void {
    try {
      const j = JSON.parse(blob);
      const state: AgentNgramState = {
        history: Array.isArray(j.history) ? j.history.slice(0, MAX_ORDER) : [],
        totalObs: Number(j.totalObs) || 0,
        vocab: new Set(Array.isArray(j.vocab) ? j.vocab : []),
        counts: new Map(),
        recentScores: Array.isArray(j.recentScores) ? j.recentScores.slice(-WINDOW_SIZE) : [],
      };
      for (const [k, entries] of (j.counts ?? [])) {
        const m = new Map<string, number>();
        for (const [tool, c] of entries) m.set(tool, c);
        state.counts.set(k, m);
      }
      this.byAgent.set(agentId, state);
    } catch {
      this.byAgent.delete(agentId);
    }
  }

  /** Score the next tool call given the agent's history, THEN update
   *  the model with this observation. Returns the score so the caller
   *  can feed it into the composite anomaly decision. */
  scoreAndUpdate(agentId: string, toolName: string): SequenceAnomalyResult {
    const state = this.byAgent.get(agentId) ?? this.newState();
    this.byAgent.set(agentId, state);

    // Cold-start: the first observation has no prior — we can't fairly
    // call it anomalous. Score 0, mark novel, update model.
    if (state.totalObs === 0) {
      this.observe(state, toolName);
      return {
        step_score: 0, window_mean: 0, is_anomaly: false,
        baseline_size: state.totalObs, novel_call: true, unusual_pair: false,
      };
    }

    // Compute -log2 P(next | history) with Witten-Bell backoff.
    const novel = !state.vocab.has(toolName);
    const unusual_pair = state.history.length > 0
      ? !this.bigramSeen(state, state.history[state.history.length - 1], toolName)
      : false;
    const p = this.predict(state, toolName);
    const step_score = -Math.log2(Math.max(p, 1e-12));

    // Update rolling-window mean.
    state.recentScores.push(step_score);
    if (state.recentScores.length > WINDOW_SIZE) state.recentScores.shift();
    const window_mean = state.recentScores.reduce((a, b) => a + b, 0) / state.recentScores.length;

    // Update the model AFTER scoring (so the current observation
    // doesn't contaminate its own prediction).
    this.observe(state, toolName);

    return {
      step_score,
      window_mean,
      is_anomaly: step_score >= ANOMALY_BITS,
      baseline_size: state.totalObs,
      novel_call: novel,
      unusual_pair,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────

  private newState(): AgentNgramState {
    return { history: [], counts: new Map(), totalObs: 0, vocab: new Set(), recentScores: [] };
  }

  /** Record one observation in the model. Increments every order's
   *  counts at the corresponding context length. */
  private observe(s: AgentNgramState, tool: string): void {
    for (let order = 0; order <= Math.min(MAX_ORDER - 1, s.history.length); order++) {
      const ctx = s.history.slice(s.history.length - order).join('|');
      const tbl = s.counts.get(ctx) ?? new Map<string, number>();
      tbl.set(tool, (tbl.get(tool) ?? 0) + 1);
      s.counts.set(ctx, tbl);
    }
    s.vocab.add(tool);
    s.totalObs++;
    s.history.push(tool);
    if (s.history.length > MAX_ORDER - 1) s.history.shift();
  }

  /** Witten-Bell smoothed prediction. At each backoff order we mix
   *  the maximum-likelihood estimate with the lower-order distribution
   *  weighted by the number of unique continuations the context has
   *  seen. Standard NLP technique; handles sparse contexts gracefully. */
  private predict(s: AgentNgramState, tool: string): number {
    // Use the freshest history; trim to MAX_ORDER-1.
    const hist = s.history.slice(-Math.min(MAX_ORDER - 1, s.history.length));
    return this.predictAt(s, hist, tool);
  }

  private predictAt(s: AgentNgramState, hist: string[], tool: string): number {
    if (hist.length === 0) {
      // Unigram fallback: c(tool) / N, smoothed by 1/(|V|+1) to avoid
      // zero on novel tools.
      const c = s.counts.get('')?.get(tool) ?? 0;
      const V = s.vocab.size || 1;
      return (c + 1) / (s.totalObs + V + 1);
    }
    const ctx = hist.join('|');
    const tbl = s.counts.get(ctx);
    if (!tbl) {
      // No context history → drop one element from the left and recurse.
      return this.predictAt(s, hist.slice(1), tool);
    }
    const c = tbl.get(tool) ?? 0;
    let N = 0;
    let T = tbl.size;       // number of unique continuations
    for (const v of tbl.values()) N += v;
    if (N === 0) return this.predictAt(s, hist.slice(1), tool);
    const lambdaLower = T / (T + N);
    const lambdaHigh  = 1 - lambdaLower;
    const lower = this.predictAt(s, hist.slice(1), tool);
    return lambdaHigh * (c / N) + lambdaLower * lower;
  }

  private bigramSeen(s: AgentNgramState, prev: string, next: string): boolean {
    const tbl = s.counts.get(prev);
    if (!tbl) return false;
    return tbl.has(next);
  }
}

/** Mix the sequence anomaly score into the composite anomaly decision.
 *  Returns the additive contribution (0..1) to the composite score
 *  that the existing AnomalyDetector already aggregates.
 *
 *  Mapping:
 *    step_score < 3 bits     →  +0      (tool is well-predicted)
 *    step_score 3 - 5.5 bits →  +0.25   (mildly surprising)
 *    step_score 5.5 - 8 bits →  +0.5    (anomalous; threshold hit)
 *    step_score ≥ 8 bits     →  +0.75   (very anomalous)
 *
 *  Plus +0.25 for novel_call and +0.25 for unusual_pair (clamped to 1.0).
 *  The composite scorer remains the source of truth; this is one
 *  contributor among many. */
export function sequenceContribution(r: SequenceAnomalyResult): number {
  // Cold-start observations contribute nothing — the model can't
  // judge an agent's first call.
  if (r.baseline_size < 5) return 0;
  let s = 0;
  if (r.step_score < 3) s += 0;
  else if (r.step_score < 5.5) s += 0.25;
  else if (r.step_score < 8) s += 0.5;
  else s += 0.75;
  if (r.novel_call)   s += 0.25;
  if (r.unusual_pair) s += 0.25;
  return Math.min(s, 1);
}
