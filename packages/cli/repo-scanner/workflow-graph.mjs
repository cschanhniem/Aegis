/**
 * Workflow graph extractor — builds the node/edge topology of an
 * LLM-agent workflow from source code.
 *
 * Output shape (independent of the source framework):
 *
 *   {
 *     framework: 'langgraph' | 'crewai' | 'autogen' | 'mastra' | 'vercel-ai' | 'unknown',
 *     nodes: [
 *       { id, kind: 'agent' | 'tool' | 'router' | 'sink', label?, framework_meta? },
 *     ],
 *     edges: [
 *       { from, to, kind: 'edge' | 'conditional' | 'handoff' | 'tool_call', label? },
 *     ],
 *     entry_points: [nodeId],         // workflow entry node(s)
 *     terminals: [nodeId],            // END / sink nodes
 *   }
 *
 * This is the input policy-generation needs to write "per-node"
 * policies — e.g. "the sql_query node may only run SELECT", "the
 * web_search node must use HTTPS targets only".
 *
 * Detection approach: source-level pattern matching. Each framework
 * has a small grammar of "this is a node" / "this is an edge" calls.
 * We scan the file's text + (when available) the tree-sitter AST for
 * those calls and assemble the graph. The framework heuristic comes
 * from the existing IMPORT_SIGNATURES + WORKFLOW_PATTERNS table.
 *
 * No tree-sitter dependency required at runtime — every detector uses
 * source-level regex over the file body. That keeps this module usable
 * inside `tryDetectWorkflows` from any framework.
 */

const FRAMEWORK_DETECTORS = {
  // ── LangGraph (Python + JS) ────────────────────────────────────
  langgraph: {
    detect: (text) => /\b(?:from\s+langgraph|import\s+langgraph|@langchain\/langgraph)\b/.test(text)
                   || /StateGraph\s*\(/.test(text)
                   || /MessageGraph\s*\(/.test(text),
    extractNodes(text, nodes) {
      // `graph.add_node("name", fn)` / `.add_node('name', fn)`
      for (const m of text.matchAll(/\.add_node\s*\(\s*['"]([^'"]+)['"]\s*,/g)) {
        nodes.push({ id: m[1], kind: 'agent', label: m[1], framework_meta: 'langgraph.node' })
      }
      // The reserved END / START nodes
      if (/\bEND\b/.test(text)) nodes.push({ id: 'END', kind: 'sink', label: 'END', framework_meta: 'langgraph.END' })
      if (/\bSTART\b/.test(text)) nodes.push({ id: 'START', kind: 'agent', label: 'START', framework_meta: 'langgraph.START' })
    },
    extractEdges(text, edges, nodes) {
      // `.add_edge("from", "to")` — unconditional
      for (const m of text.matchAll(/\.add_edge\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)) {
        edges.push({ from: m[1], to: m[2], kind: 'edge' })
      }
      // `.add_conditional_edges("from", router_fn, {"a": "b", "c": "d"})`
      for (const m of text.matchAll(/\.add_conditional_edges\s*\(\s*['"]([^'"]+)['"]\s*,[^,]+,\s*\{([^}]+)\}\s*\)/g)) {
        const from = m[1]
        for (const lm of m[2].matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)) {
          edges.push({ from, to: lm[2], kind: 'conditional', label: lm[1] })
        }
      }
      // Set entry / finish: graph.set_entry_point("x"), .set_finish_point("y")
      // These imply the START / END pseudo-nodes — synthesise them if
      // they aren't already in the node list so entry_points /
      // terminals derivation picks them up.
      const hasStart = nodes.some(n => n.id === 'START')
      const hasEnd   = nodes.some(n => n.id === 'END')
      for (const m of text.matchAll(/\.set_entry_point\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (!hasStart && !nodes.some(n => n.id === 'START')) {
          nodes.unshift({ id: 'START', kind: 'agent', label: 'START', framework_meta: 'langgraph.START' })
        }
        edges.push({ from: 'START', to: m[1], kind: 'edge' })
      }
      for (const m of text.matchAll(/\.set_finish_point\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (!hasEnd && !nodes.some(n => n.id === 'END')) {
          nodes.push({ id: 'END', kind: 'sink', label: 'END', framework_meta: 'langgraph.END' })
        }
        edges.push({ from: m[1], to: 'END', kind: 'edge' })
      }
    },
  },

  // ── CrewAI (Python) ────────────────────────────────────────────
  // CrewAI workflow: Crew(agents=[Agent(...), ...], tasks=[Task(...)]).
  // We extract agents by `Agent(role="...", goal="...")` literals, tasks
  // by `Task(...)`, and edges by the order of `tasks=[...]` (CrewAI runs
  // them sequentially by default) or `process=Process.hierarchical`.
  crewai: {
    detect: (text) => /\b(?:from\s+crewai|import\s+crewai)\b/.test(text)
                   || /\bCrew\s*\(/.test(text),
    extractNodes(text, nodes) {
      // Agents — match `Agent(role="...")` capturing the role as id.
      const seenAgents = new Set()
      for (const m of text.matchAll(/Agent\s*\(\s*role\s*=\s*['"]([^'"]+)['"]/g)) {
        const id = m[1]
        if (seenAgents.has(id)) continue
        seenAgents.add(id)
        nodes.push({ id, kind: 'agent', label: id, framework_meta: 'crewai.agent' })
      }
      // Tasks — match `Task(description="...", agent=role_var)` — agent
      // ref is identifier so we fall back to the description string.
      const seenTasks = new Set()
      for (const m of text.matchAll(/Task\s*\(\s*description\s*=\s*['"]([^'"]{1,80})/g)) {
        const id = `task:${m[1].slice(0, 40).replace(/\s+/g, '_')}`
        if (seenTasks.has(id)) continue
        seenTasks.add(id)
        nodes.push({ id, kind: 'agent', label: m[1].slice(0, 40), framework_meta: 'crewai.task' })
      }
    },
    extractEdges(text, edges, nodes) {
      // CrewAI runs tasks sequentially by default. We approximate that
      // by chaining the task nodes in declared order.
      const taskNodes = nodes.filter(n => n.framework_meta === 'crewai.task')
      for (let i = 1; i < taskNodes.length; i++) {
        edges.push({ from: taskNodes[i - 1].id, to: taskNodes[i].id, kind: 'edge' })
      }
    },
  },

  // ── AutoGen / AutoGen Studio (Python) ──────────────────────────
  autogen: {
    detect: (text) => /\b(?:from\s+autogen|import\s+autogen)\b/.test(text)
                   || /GroupChat\s*\(/.test(text)
                   || /UserProxyAgent\s*\(|AssistantAgent\s*\(/.test(text),
    extractNodes(text, nodes) {
      // `agent_x = AssistantAgent(name="researcher", ...)` — variable
      // assignment to a typed constructor.
      const KINDS = [
        ['AssistantAgent', 'assistant'],
        ['UserProxyAgent', 'user_proxy'],
        ['ConversableAgent', 'conversable'],
        ['GroupChatManager', 'router'],
      ];
      const seen = new Set()
      for (const [ctor, meta] of KINDS) {
        const re = new RegExp(`${ctor}\\s*\\(\\s*name\\s*=\\s*['"]([^'"]+)['"]`, 'g')
        for (const m of text.matchAll(re)) {
          const id = m[1]
          if (seen.has(id)) continue
          seen.add(id)
          nodes.push({
            id, label: id,
            kind: ctor === 'GroupChatManager' ? 'router' : 'agent',
            framework_meta: `autogen.${meta}`,
          })
        }
      }
    },
    extractEdges(text, edges, nodes) {
      // GroupChat(agents=[a, b, c], ...) — every agent is reachable
      // from the manager; model as fan-out + fan-in.
      const m = text.match(/GroupChat\s*\(\s*agents\s*=\s*\[([^\]]+)\]/)
      if (m) {
        const ids = Array.from(m[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)).map(x => x[1])
        // Variable refs — try to align with agent var-names we DON'T
        // have. Best-effort: just connect every agent we found to a
        // synthetic "GroupChat" router.
        nodes.push({ id: 'group_chat', kind: 'router', label: 'GroupChat', framework_meta: 'autogen.group_chat' })
        for (const n of nodes) {
          if (n.id === 'group_chat') continue
          edges.push({ from: 'group_chat', to: n.id, kind: 'handoff' })
        }
      }
    },
  },

  // ── Mastra (JS / TS) ────────────────────────────────────────────
  mastra: {
    detect: (text) => /from\s+["']@mastra\/core["']/.test(text)
                   || /\bnew\s+Mastra\s*\(/.test(text),
    extractNodes(text, nodes) {
      // `agents: { x: new Agent({...}) }` or `tools: { search: createTool(...) }`
      for (const m of text.matchAll(/(\w+)\s*:\s*new\s+Agent\s*\(/g)) {
        nodes.push({ id: m[1], kind: 'agent', label: m[1], framework_meta: 'mastra.agent' })
      }
      for (const m of text.matchAll(/(\w+)\s*:\s*createTool\s*\(/g)) {
        nodes.push({ id: m[1], kind: 'tool', label: m[1], framework_meta: 'mastra.tool' })
      }
    },
    extractEdges() { /* Mastra agent→tool wiring is implicit; we add it via tool_call edges only when we see direct invocations. */ },
  },

  // ── Vercel AI SDK (JS / TS) ─────────────────────────────────────
  'vercel-ai': {
    detect: (text) => /from\s+["']ai["']/.test(text)
                   || /\bgenerateText\s*\(/.test(text)
                   || /\bstreamText\s*\(/.test(text),
    extractNodes(text, nodes) {
      // Vercel AI uses inline `tools: { weather: { … } }`. Pull each key.
      const toolsBlock = text.match(/tools\s*:\s*\{([\s\S]+?)\n\s*\}/)
      if (toolsBlock) {
        for (const m of toolsBlock[1].matchAll(/(\w+)\s*:\s*\{/g)) {
          nodes.push({ id: m[1], kind: 'tool', label: m[1], framework_meta: 'vercel-ai.tool' })
        }
      }
    },
    extractEdges() {},
  },
}

/** Public entry: extract a workflow graph from one file's source.
 *  Returns null if no known framework detected — caller decides
 *  whether to surface that as "unknown framework" or skip. */
export function extractWorkflowGraph(source) {
  if (!source) return null
  for (const [framework, detector] of Object.entries(FRAMEWORK_DETECTORS)) {
    if (!detector.detect(source)) continue
    const nodes = []
    const edges = []
    detector.extractNodes(source, nodes)
    detector.extractEdges(source, edges, nodes)
    if (nodes.length === 0) continue
    // De-dup edges (multiple detectors / overlapping matches).
    const seen = new Set()
    const deduped = edges.filter(e => {
      const k = `${e.from}|${e.to}|${e.kind}|${e.label ?? ''}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    // Entry / terminal heuristics:
    //   - entry_points: nodes with no incoming edges (sources)
    //   - terminals:    sinks + nodes with no outgoing edges
    const incoming = new Set(deduped.map(e => e.to))
    const outgoing = new Set(deduped.map(e => e.from))
    const entry_points = nodes
      .filter(n => !incoming.has(n.id) && n.kind !== 'sink')
      .map(n => n.id)
    const terminals = nodes
      .filter(n => n.kind === 'sink' || !outgoing.has(n.id))
      .map(n => n.id)
    return { framework, nodes, edges: deduped, entry_points, terminals }
  }
  return null
}

/** Aggregate multiple files into one repo-level workflow graph.
 *  Useful when an agent is split across modules (one file per agent,
 *  one file per tool). De-dupes by `id` across files. */
export function aggregateWorkflowGraphs(perFile) {
  const out = { framework: 'unknown', nodes: [], edges: [], entry_points: [], terminals: [] }
  const seenNodes = new Set()
  const seenEdges = new Set()
  // Prefer the first framework that fires; mixed frameworks get
  // labelled `mixed` so the caller can detect it.
  let firstFramework = null
  for (const g of perFile) {
    if (!g) continue
    if (firstFramework === null) firstFramework = g.framework
    else if (firstFramework !== g.framework) firstFramework = 'mixed'
    for (const n of g.nodes) {
      if (seenNodes.has(n.id)) continue
      seenNodes.add(n.id)
      out.nodes.push(n)
    }
    for (const e of g.edges) {
      const k = `${e.from}|${e.to}|${e.kind}|${e.label ?? ''}`
      if (seenEdges.has(k)) continue
      seenEdges.add(k)
      out.edges.push(e)
    }
  }
  out.framework = firstFramework ?? 'unknown'
  // Recompute entry/terminal across the merged graph.
  const incoming = new Set(out.edges.map(e => e.to))
  const outgoing = new Set(out.edges.map(e => e.from))
  out.entry_points = out.nodes.filter(n => !incoming.has(n.id) && n.kind !== 'sink').map(n => n.id)
  out.terminals   = out.nodes.filter(n => n.kind === 'sink' || !outgoing.has(n.id)).map(n => n.id)
  return out
}
