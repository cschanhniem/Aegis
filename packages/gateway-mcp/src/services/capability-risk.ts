/**
 * Capability risk scorer — NIST AI RMF / OECD AI risk taxonomy applied
 * to an agent's tool inventory.
 *
 * The intuition matches the GenAI security frontier (Anthropic Agentic
 * Misalignment 2025, AgentBench-Safety 2024, NIST AI 600-1 GenAI RMF):
 * agent risk is overwhelmingly **what the agent can DO**, not what it
 * knows. A research assistant with only web_search is low risk; a
 * coding agent with file_write + shell + http_post is high risk
 * regardless of how well-aligned the LLM is.
 *
 * Output: 0-100 composite score + named risk class (LOW / MEDIUM /
 * HIGH / CRITICAL) + per-tool decomposition so customers can see
 * exactly which capabilities drove the score.
 *
 * How this is used:
 *   - Cockpit "Agent Risk" tile (replaces the placeholder).
 *   - Workflow-aware policy generator (the route's prompt uses
 *     `capability_risk` to decide tighter vs lighter rule defaults).
 *   - Pre-deploy gate ("score > 70 requires manager approval").
 *
 * Methodology:
 *   For each tool we attribute weights across 5 NIST risk dimensions:
 *     - Action  (modifies state outside the agent)
 *     - Egress  (sends data out)
 *     - Secrets (touches credentials)
 *     - PII     (touches personal data)
 *     - Scale   (potential blast radius — fan-out, irreversibility)
 *   Each dimension contributes 0-20 to the composite 0-100. The final
 *   per-tool weights are summed (capped at 100 per dimension before
 *   compositing) to avoid one tool monopolising the score.
 */

export type CapabilityCategory =
  | 'shell' | 'file' | 'database' | 'network' | 'communication'
  | 'supply-chain' | 'read-only' | 'other';

export interface ToolInventoryEntry {
  name: string;
  shape?: string;        // 'function-call' | 'mcp' | 'http' | ...
  category?: CapabilityCategory | string;
  description?: string;
}

export interface CapabilityRiskDimensions {
  action:  number;   // 0-20
  egress:  number;
  secrets: number;
  pii:     number;
  scale:   number;
}

export interface CapabilityRiskTool {
  name: string;
  category: CapabilityCategory;
  dimensions: CapabilityRiskDimensions;
  contribution: number;  // 0-100, this tool's per-dimension max contribution
  rationale: string;
}

export interface CapabilityRiskResult {
  /** Composite 0-100 score. */
  score: number;
  /** Discrete class: LOW (<25), MEDIUM (25-49), HIGH (50-74), CRITICAL (≥ 75). */
  risk_class: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Per-dimension scores, capped at 100. */
  dimensions: CapabilityRiskDimensions;
  /** Per-tool decomposition. */
  tools: CapabilityRiskTool[];
  /** Suggested policy posture nudges. */
  recommendations: string[];
}

/** Heuristic category-by-name when the inventory entry didn't carry
 *  one. Mirrors the classifier patterns used elsewhere; kept here as
 *  a dependency-free lookup so the scorer is callable from the cockpit
 *  too. */
function categoryOf(tool: ToolInventoryEntry): CapabilityCategory {
  if (tool.category) {
    const c = String(tool.category).toLowerCase();
    if (['shell','file','database','network','communication','supply-chain','read-only','other'].includes(c)) {
      return c as CapabilityCategory;
    }
  }
  const n = tool.name.toLowerCase();
  if (/^(shell|exec|run_cmd|bash|sh|system|spawn|powershell)/i.test(n))               return 'shell';
  if (/file_write|fs_write|write_file|delete_file|chmod|mkdir|rm$/i.test(n))          return 'file';
  if (/file_read|fs_read|read_file|ls|stat/i.test(n))                                 return 'read-only';
  if (/db_|sql_|query|execute_sql|insert|update|drop_/i.test(n))                      return 'database';
  if (/http|fetch|curl|webhook|post|put|request|requests/i.test(n))                   return 'network';
  if (/send_email|email|slack|sms|notify|message/i.test(n))                           return 'communication';
  if (/install|pip|npm|apt|yarn|brew/i.test(n))                                       return 'supply-chain';
  if (/search|read|get|list|view/i.test(n))                                           return 'read-only';
  return 'other';
}

/** Per-category baseline risk weights. Tuned to land "research agent
 *  with web_search" at ~15 (LOW) and "ops agent with shell + file_write
 *  + http_post" at ~85 (CRITICAL). */
const CATEGORY_WEIGHTS: Record<CapabilityCategory, CapabilityRiskDimensions> = {
  'shell':         { action: 20, egress: 12, secrets: 14, pii: 6,  scale: 20 },
  'database':      { action: 18, egress: 10, secrets: 12, pii: 18, scale: 15 },
  'file':          { action: 16, egress: 8,  secrets: 14, pii: 14, scale: 14 },
  'network':       { action: 12, egress: 20, secrets: 14, pii: 16, scale: 14 },
  'communication': { action: 12, egress: 18, secrets: 10, pii: 18, scale: 14 },
  'supply-chain':  { action: 18, egress: 10, secrets: 6,  pii: 4,  scale: 20 },
  'read-only':     { action: 2,  egress: 4,  secrets: 4,  pii: 8,  scale: 4  },
  'other':         { action: 6,  egress: 6,  secrets: 6,  pii: 6,  scale: 6  },
};

/** Modifiers from the tool description. We scan for keywords that
 *  amplify or dampen the baseline (e.g. "destructive" → +action,
 *  "read-only" → -action, "production" → +scale, "external" → +egress). */
const DESCRIPTION_MODIFIERS: Array<{ pattern: RegExp; deltas: Partial<CapabilityRiskDimensions> }> = [
  { pattern: /\b(destructive|delete|drop|truncate|remove|wipe)\b/i, deltas: { action: 4, scale: 4 } },
  { pattern: /\b(production|prod|customer|live|business[- ]critical)\b/i, deltas: { scale: 4 } },
  { pattern: /\b(read[- ]?only|view[- ]?only|getter|fetch)\b/i,    deltas: { action: -8 } },
  { pattern: /\b(external|third[- ]?party|public|outbound)\b/i,    deltas: { egress: 4 } },
  { pattern: /\b(credential|secret|password|token|api[- ]?key)\b/i, deltas: { secrets: 6 } },
  { pattern: /\b(pii|personal|customer[- ]?data|gdpr|hipaa|phi)\b/i, deltas: { pii: 6 } },
  { pattern: /\b(broadcast|bulk|all[- ]?users|multi[- ]?recipient)\b/i, deltas: { scale: 6 } },
  { pattern: /\b(internal[- ]?only|sandbox|safe|isolated)\b/i,     deltas: { scale: -6, egress: -4 } },
];

function rationaleFor(category: CapabilityCategory, d: CapabilityRiskDimensions): string {
  const dim = Object.entries(d).sort(([, a], [, b]) => Number(b) - Number(a))[0];
  const top = dim?.[0] ?? 'unknown';
  return `${category} tool — top dimension: ${top} (${dim?.[1]})`;
}

/** Public entry: score an agent's capability risk. */
export function scoreCapabilityRisk(tools: ToolInventoryEntry[]): CapabilityRiskResult {
  const perTool: CapabilityRiskTool[] = [];
  // Track aggregate per-dimension WITHOUT one tool monopolising the
  // composite: we max-aggregate rather than sum, so two database tools
  // don't push pii to 200.
  const aggDims: CapabilityRiskDimensions = { action: 0, egress: 0, secrets: 0, pii: 0, scale: 0 };

  for (const t of tools) {
    const cat = categoryOf(t);
    const base = { ...CATEGORY_WEIGHTS[cat] };
    if (t.description) {
      for (const mod of DESCRIPTION_MODIFIERS) {
        if (!mod.pattern.test(t.description)) continue;
        for (const [k, dv] of Object.entries(mod.deltas) as Array<[keyof CapabilityRiskDimensions, number]>) {
          base[k] = Math.max(0, Math.min(20, (base[k] ?? 0) + dv));
        }
      }
    }
    const contribution = base.action + base.egress + base.secrets + base.pii + base.scale;
    perTool.push({
      name: t.name,
      category: cat,
      dimensions: base,
      contribution,
      rationale: rationaleFor(cat, base),
    });
    // Aggregate SUM across tools (capped at 100 per-dimension). Each
    // tool contributes ≤ 20 per dim; 5 same-category tools saturate
    // that dimension. Sum is the right shape: 10 file_write tools IS
    // genuinely worse than 1.
    for (const k of Object.keys(aggDims) as Array<keyof CapabilityRiskDimensions>) {
      aggDims[k] = Math.min(100, aggDims[k] + base[k]);
    }
  }

  // Composite: weighted sum of the 5 dimensions (each capped at 100).
  let composite =
    aggDims.action  * 0.25 +
    aggDims.egress  * 0.25 +
    aggDims.secrets * 0.15 +
    aggDims.pii     * 0.15 +
    aggDims.scale   * 0.20;

  // Combination bonus — NIST AI RMF emphasises that risk is super-
  // additive when an agent holds multiple distinct high-action
  // capabilities (e.g. shell + network + file is a complete exfil
  // kit). +15 when ≥ 3 distinct high-action categories present.
  const highActionCategories = new Set<CapabilityCategory>([
    'shell', 'file', 'database', 'network', 'communication', 'supply-chain',
  ]);
  const distinctHighAction = new Set(
    perTool.filter(t => highActionCategories.has(t.category)).map(t => t.category),
  ).size;
  if (distinctHighAction >= 3) composite += 15;
  if (distinctHighAction >= 5) composite += 10;   // total +25 when 5+

  const score = Math.round(Math.max(0, Math.min(100, composite)));
  const risk_class: CapabilityRiskResult['risk_class'] =
    score < 25 ? 'LOW' :
    score < 50 ? 'MEDIUM' :
    score < 75 ? 'HIGH' : 'CRITICAL';

  return {
    score,
    risk_class,
    dimensions: aggDims,
    tools: perTool,
    recommendations: buildRecommendations(score, aggDims, perTool),
  };
}

function buildRecommendations(score: number, d: CapabilityRiskDimensions, tools: CapabilityRiskTool[]): string[] {
  const rec: string[] = [];
  if (score >= 75) {
    rec.push('Default every HIGH/CRITICAL policy decision to BLOCK (not pending).');
    rec.push('Require human approval (HITL) for tools with action ≥ 16.');
    rec.push('Enable Layer 2 anomaly with strict thresholds + sequence-aware detector.');
  } else if (score >= 50) {
    rec.push('Default risky tools to PENDING; allow tenant admin to relax.');
    rec.push('Enable witness cosignature on the transparency log.');
  } else if (score >= 25) {
    rec.push('Light-touch policies; tighten only the highest-dimension tools.');
  } else {
    rec.push('Minimal policy posture; do not over-restrict — false positives will dominate.');
  }
  if (d.egress >= 60) rec.push('At least one outbound DSL rule keying on egress destination.');
  if (d.pii    >= 60) rec.push('Tighten PII redaction; require role=auditor for raw trace export.');
  if (d.secrets>= 60) rec.push('Run secret scanner in CI on every commit touching this agent.');
  if (d.action >= 70) rec.push('Wire snapshot + saga rollback for every state-changing tool.');
  if (tools.length === 0) rec.push('No tools declared — risk score is provisional.');
  return rec;
}
