/**
 * Workflow gap analysis — cross-check the operator's natural-language
 * description against the agent's actual tool inventory.
 *
 * Purpose: catch the two failure modes operators hit most often:
 *   1. User asks AEGIS to "block destructive DB writes" but the agent
 *      has no DB tool → the resulting policy never fires, giving false
 *      sense of security.
 *   2. The agent has a tool (e.g. shell_exec) the user didn't mention,
 *      so no policy covers it → an obvious gap nobody noticed.
 *
 * Both failures are silent without this check. The wizard renders the
 * gaps as warnings BEFORE the operator clicks "Save to gateway".
 *
 * Industrial-grade-ness note: the matching is lexical (substring) plus
 * a tiny categorical dictionary. We deliberately don't reach for an
 * embedding model here — the value is in surfacing the disagreement,
 * and an operator skimming an obvious table catches the issue. An
 * embedding lookup would add latency + dependency on an external model
 * for ~5% better matching.
 */

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  database:      ['db', 'database', 'sql', 'postgres', 'mysql', 'redis', 'mongo', 'firestore', 'select', 'insert', 'update', 'delete', 'drop', 'query'],
  shell:         ['shell', 'bash', 'sh', 'exec', 'command', 'subprocess', 'execute', 'run'],
  file:          ['file', 'fs', 'filesystem', 'read', 'write', 'unlink', 'rm', 'cp', 'mv'],
  network:       ['http', 'fetch', 'curl', 'request', 'api', 'webhook', 'url', 'endpoint'],
  communication: ['email', 'mail', 'sms', 'slack', 'telegram', 'message', 'notify', 'send'],
  code:          ['eval', 'compile', 'pip', 'npm', 'install', 'code', 'script'],
}

const SENSITIVE_KEYWORDS = [
  'delete', 'drop', 'truncate', 'shutdown', 'kill', 'destroy', 'remove',
  'destructive', 'critical', 'production', 'prod', 'sensitive', 'block',
  'forbid', 'restrict', 'disable',
]

export interface ToolInventoryEntry {
  name: string
  shape?: string
}

export interface WorkflowGap {
  /** Tools mentioned by NAME (or strong substring) in the description but
   *  NOT present in the scanned inventory. */
  mentioned_not_in_inventory: string[]
  /** Tools that appear in the inventory but aren't referenced — explicitly
   *  or by category — anywhere in the description. The operator should
   *  decide if any deserve a policy. */
  inventory_not_in_description: string[]
  /** Categories the operator mentioned that have at least one matching
   *  tool — surface so the operator confirms our matching is correct. */
  category_matches: Array<{ category: string; tool: string }>
  /** Boolean: there are tools but the description doesn't reference any
   *  category that intersects with them. Often a "this policy will be
   *  scoped wrong" red flag. */
  empty_intersection: boolean
}

export function analyzeWorkflowGap(
  description: string,
  inventory: ToolInventoryEntry[],
): WorkflowGap {
  const desc = description.toLowerCase()
  const invNames = inventory.map(t => t.name)

  // 1. Did the operator name a tool that we don't see?
  //    Heuristic: tokenise into words 3+ chars, look for any that don't
  //    appear in the inventory. Skip too-common stopwords.
  const STOPWORDS = new Set([
    'the','this','that','our','your','their','any','all','some','none',
    'with','from','into','for','and','but','not','can','will','should',
    'agent','agents','tool','tools','call','calls','use','using','make',
    'block','allow','pending','review','only','also','then','when','where',
    'database','file','shell','network','email','message','code','api',
  ])
  // Words the operator probably means as tools: tokens longer than 3 chars
  // that look like identifiers and aren't stopwords.
  const tokenRe = /\b([a-z][a-z_]{2,30})\b/g
  const operatorTokens = new Set<string>()
  const tokenMatches = Array.from(desc.matchAll(tokenRe))
  for (const m of tokenMatches) {
    if (!STOPWORDS.has(m[1])) operatorTokens.add(m[1])
  }
  // Treat token "matches tool" loosely: the tool name is a substring of
  // the operator token, or vice versa, ignoring underscores vs spaces.
  const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, '')
  const invSet = new Set(invNames.map(norm))
  const operatorIdentifiedAsTools = Array.from(operatorTokens)
    .filter(t => t.includes('_') || /[a-z]_[a-z]/.test(t))   // looks identifier-shaped
    .map(norm)
  const mentioned_not_in_inventory = operatorIdentifiedAsTools
    .filter(t => !invSet.has(t) && !Array.from(invSet).some(it => it.includes(t) || t.includes(it)))

  // 2. Which inventory tools are NOT referenced in any way?
  const mentionedCategories = new Set<string>()
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => desc.includes(w))) mentionedCategories.add(cat)
  }
  function categoryOf(toolName: string): string | null {
    const lower = toolName.toLowerCase()
    for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
      if (words.some(w => lower.includes(w))) return cat
    }
    return null
  }
  const inventory_not_in_description = invNames.filter(t => {
    const lower = t.toLowerCase()
    if (desc.includes(lower)) return false                    // mentioned by name
    const cat = categoryOf(t)
    if (cat && mentionedCategories.has(cat)) return false     // mentioned by category
    return true
  })

  // 3. Category matches (informational — "we think 'block destructive DB'
  //    matches your db_query tool").
  const category_matches: Array<{ category: string; tool: string }> = []
  for (const cat of Array.from(mentionedCategories)) {
    for (const t of invNames) {
      if (categoryOf(t) === cat) category_matches.push({ category: cat, tool: t })
    }
  }

  return {
    mentioned_not_in_inventory: dedupe(mentioned_not_in_inventory),
    inventory_not_in_description: dedupe(inventory_not_in_description),
    category_matches,
    empty_intersection: invNames.length > 0 && category_matches.length === 0,
  }
}

function dedupe<T>(arr: T[]): T[] { return Array.from(new Set(arr)) }
