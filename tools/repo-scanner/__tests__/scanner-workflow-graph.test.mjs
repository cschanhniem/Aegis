/**
 * Workflow-graph extractor tests. Pins the topology shape for each
 * supported framework + the aggregator's de-dup + entry/terminal
 * derivation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCANNER = resolve(HERE, '..', 'index.mjs')
const { extractWorkflowGraph, aggregateWorkflowGraphs } = await import('../workflow-graph.mjs')

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-wfg-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

// ── LangGraph ───────────────────────────────────────────────────────

test('LangGraph: extracts nodes from add_node + edges from add_edge', () => {
  const g = extractWorkflowGraph(`
from langgraph.graph import StateGraph, END
g = StateGraph(MyState)
g.add_node("planner", plan_fn)
g.add_node("executor", exec_fn)
g.add_node("verifier", verify_fn)
g.set_entry_point("planner")
g.add_edge("planner", "executor")
g.add_edge("executor", "verifier")
g.set_finish_point("verifier")
`)
  expect_(g, 'LangGraph detected')
  assert.equal(g.framework, 'langgraph')
  const nodeIds = g.nodes.map(n => n.id).sort()
  assert.ok(nodeIds.includes('planner'))
  assert.ok(nodeIds.includes('executor'))
  assert.ok(nodeIds.includes('verifier'))
  assert.ok(nodeIds.includes('END'))
  assert.ok(g.edges.some(e => e.from === 'planner' && e.to === 'executor'))
  assert.ok(g.edges.some(e => e.from === 'verifier' && e.to === 'END'))
  assert.ok(g.entry_points.includes('START'))
  assert.ok(g.terminals.includes('END'))
})

test('LangGraph: conditional edges decompose into one edge per branch', () => {
  const g = extractWorkflowGraph(`
from langgraph.graph import StateGraph, END
g = StateGraph(S)
g.add_node("router", route)
g.add_node("a", a_fn)
g.add_node("b", b_fn)
g.add_conditional_edges("router", decide, {"to_a": "a", "to_b": "b"})
`)
  assert.ok(g.edges.some(e => e.from === 'router' && e.to === 'a' && e.kind === 'conditional' && e.label === 'to_a'))
  assert.ok(g.edges.some(e => e.from === 'router' && e.to === 'b' && e.kind === 'conditional' && e.label === 'to_b'))
})

// ── CrewAI ──────────────────────────────────────────────────────────

test('CrewAI: extracts agent roles + chains tasks sequentially', () => {
  const g = extractWorkflowGraph(`
from crewai import Agent, Task, Crew
researcher = Agent(role="researcher", goal="find papers")
writer    = Agent(role="writer", goal="write summary")
task1 = Task(description="research the topic", agent=researcher)
task2 = Task(description="write the summary", agent=writer)
crew = Crew(agents=[researcher, writer], tasks=[task1, task2])
`)
  assert.equal(g.framework, 'crewai')
  assert.ok(g.nodes.find(n => n.id === 'researcher'))
  assert.ok(g.nodes.find(n => n.id === 'writer'))
  const tasks = g.nodes.filter(n => n.framework_meta === 'crewai.task')
  assert.equal(tasks.length, 2)
  // Sequential edge between the two tasks.
  assert.ok(g.edges.some(e => e.from === tasks[0].id && e.to === tasks[1].id))
})

// ── AutoGen ─────────────────────────────────────────────────────────

test('AutoGen: extracts AssistantAgent + UserProxyAgent + GroupChat handoffs', () => {
  const g = extractWorkflowGraph(`
from autogen import AssistantAgent, UserProxyAgent, GroupChat, GroupChatManager
alice = AssistantAgent(name="alice", llm_config=cfg)
bob   = AssistantAgent(name="bob", llm_config=cfg)
user  = UserProxyAgent(name="user")
chat = GroupChat(agents=[alice, bob, user], messages=[])
mgr   = GroupChatManager(name="mgr", groupchat=chat)
`)
  assert.equal(g.framework, 'autogen')
  const ids = g.nodes.map(n => n.id).sort()
  assert.ok(ids.includes('alice'))
  assert.ok(ids.includes('bob'))
  assert.ok(ids.includes('user'))
  assert.ok(ids.includes('mgr'))
  // GroupChat synthesises a router node + handoff edges to each agent.
  assert.ok(g.nodes.find(n => n.id === 'group_chat' && n.kind === 'router'))
  assert.ok(g.edges.some(e => e.from === 'group_chat' && e.kind === 'handoff'))
})

// ── Mastra (JS) ─────────────────────────────────────────────────────

test('Mastra: extracts agents + tools from inline object literal', () => {
  const g = extractWorkflowGraph(`
import { Mastra, Agent } from '@mastra/core'
import { createTool } from '@mastra/core/tools'
const mastra = new Mastra({
  agents: {
    researcher: new Agent({ name: 'r', model: 'gpt-4o' }),
    writer:     new Agent({ name: 'w', model: 'gpt-4o' }),
  },
  tools: {
    webSearch:  createTool({ name: 'webSearch', execute: async () => {} }),
    summarize:  createTool({ name: 'summarize', execute: async () => {} }),
  },
})
`)
  assert.equal(g.framework, 'mastra')
  assert.ok(g.nodes.find(n => n.id === 'researcher' && n.kind === 'agent'))
  assert.ok(g.nodes.find(n => n.id === 'writer'     && n.kind === 'agent'))
  assert.ok(g.nodes.find(n => n.id === 'webSearch'  && n.kind === 'tool'))
  assert.ok(g.nodes.find(n => n.id === 'summarize'  && n.kind === 'tool'))
})

// ── Vercel AI SDK ───────────────────────────────────────────────────

test('Vercel AI SDK: extracts inline tools block', () => {
  const g = extractWorkflowGraph(`
import { generateText } from 'ai'
const result = await generateText({
  model: openai('gpt-4o'),
  tools: {
    weather: { description: 'get weather', execute: async () => '' },
    stocks:  { description: 'get stocks', execute: async () => '' },
  },
})
`)
  assert.equal(g.framework, 'vercel-ai')
  assert.ok(g.nodes.find(n => n.id === 'weather'))
  assert.ok(g.nodes.find(n => n.id === 'stocks'))
})

// ── Negative cases ──────────────────────────────────────────────────

test('returns null when no framework is detected', () => {
  expect_(extractWorkflowGraph('print("hello")\n') === null, 'plain code → null')
})

test('returns null on empty / nullish input', () => {
  expect_(extractWorkflowGraph('') === null, 'empty → null')
  expect_(extractWorkflowGraph(null) === null, 'null → null')
})

// ── Aggregator ──────────────────────────────────────────────────────

test('aggregateWorkflowGraphs: de-dupes nodes + edges across files', () => {
  const g1 = extractWorkflowGraph(`
from langgraph.graph import StateGraph
g = StateGraph(S)
g.add_node("a", a)
g.add_node("b", b)
g.add_edge("a", "b")
`)
  const g2 = extractWorkflowGraph(`
from langgraph.graph import StateGraph
g = StateGraph(S)
g.add_node("b", b)
g.add_node("c", c)
g.add_edge("b", "c")
`)
  const merged = aggregateWorkflowGraphs([g1, g2])
  assert.equal(merged.framework, 'langgraph')
  const ids = merged.nodes.map(n => n.id).sort()
  assert.ok(ids.includes('a'))
  assert.ok(ids.includes('b'))
  assert.ok(ids.includes('c'))
  // b appears once even though it was declared in both files
  assert.equal(ids.filter(x => x === 'b').length, 1)
  // Both edges present
  assert.ok(merged.edges.some(e => e.from === 'a' && e.to === 'b'))
  assert.ok(merged.edges.some(e => e.from === 'b' && e.to === 'c'))
})

test('aggregateWorkflowGraphs: labels mixed-framework graphs', () => {
  const g1 = { framework: 'langgraph', nodes: [{ id: 'a', kind: 'agent' }], edges: [], entry_points: [], terminals: [] }
  const g2 = { framework: 'crewai',    nodes: [{ id: 'b', kind: 'agent' }], edges: [], entry_points: [], terminals: [] }
  const merged = aggregateWorkflowGraphs([g1, g2])
  assert.equal(merged.framework, 'mixed')
})

// ── End-to-end via CLI ──────────────────────────────────────────────

test('scanner CLI emits workflow_graph into report JSON', () => {
  const repo = makeRepo({
    'pyproject.toml': 'name = "x"',
    'graph.py': `
from langgraph.graph import StateGraph, END
g = StateGraph(MyState)
g.add_node("a", a_fn)
g.add_node("b", b_fn)
g.add_edge("a", "b")
g.set_finish_point("b")
`,
  })
  try {
    const raw = execFileSync('node', [SCANNER, repo, '--json'], { encoding: 'utf8' })
    const report = JSON.parse(raw)
    expect_(report.workflow_graph, 'workflow_graph present')
    assert.equal(report.workflow_graph.framework, 'langgraph')
    const ids = report.workflow_graph.nodes.map(n => n.id)
    assert.ok(ids.includes('a'))
    assert.ok(ids.includes('b'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

function expect_(value, msg) { assert.ok(value, msg) }
