/**
 * Frontier scanner-tests: confidence scoring, workflow patterns,
 * transitive import resolution.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCANNER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-scan-frontier-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

function runScan(dir, extra = []) {
  return JSON.parse(execFileSync('node', [SCANNER, dir, '--json', ...extra], { encoding: 'utf8' }))
}

// ── Confidence scoring ─────────────────────────────────────────────────

test('confidence high: workflow-pattern entry-point', () => {
  const repo = makeRepo({
    'main.py': `
      from langgraph.graph import StateGraph
      graph = StateGraph(int)
      app = graph.compile()
    `,
  })
  try {
    const r = runScan(repo)
    const main = r.candidates.find(c => c.path === 'main.py')
    assert.equal(main.confidence, 'high')
    assert.equal(main.is_workflow_entry, true)
    assert.ok(main.workflow_patterns.includes('langgraph'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('confidence high: entry-point filename + import', () => {
  const repo = makeRepo({
    'main.py': 'import anthropic\n',
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].confidence, 'high')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('confidence medium: import in helper file (not entry-point)', () => {
  const repo = makeRepo({
    'lib/helpers.py': 'import anthropic\n',
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].confidence, 'medium')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('confidence low: HTTP-only in helper file', () => {
  const repo = makeRepo({
    'lib/util.py': `URL = "https://api.openai.com/v1/chat/completions"`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].confidence, 'low')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('summary.by_confidence reports bucketed counts', () => {
  const repo = makeRepo({
    'main.py':      'import anthropic\n',                          // high
    'lib/h.py':     'import openai\n',                              // medium
    'lib/legacy.py':`r = "https://api.openai.com/v1"`,              // low
    'claude_desktop_config.json': JSON.stringify({ mcpServers: { fs: { command: 'x' } } }), // high
  })
  try {
    const r = runScan(repo)
    assert.ok(r.summary.by_confidence.high >= 2)
    assert.ok(r.summary.by_confidence.medium >= 1)
    assert.ok(r.summary.by_confidence.low >= 1)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── Workflow detection ─────────────────────────────────────────────────

test('workflow: LangChain AgentExecutor recognised', () => {
  const repo = makeRepo({
    'svc.py': `
      from langchain.agents import AgentExecutor
      executor = AgentExecutor(agent=None, tools=[])
    `,
  })
  try {
    const r = runScan(repo)
    const c = r.candidates[0]
    assert.equal(c.is_workflow_entry, true)
    assert.ok(c.workflow_patterns.includes('langchain-executor'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('workflow: CrewAI Crew kickoff recognised', () => {
  const repo = makeRepo({
    'svc.py': `
      from crewai import Crew, Agent
      crew = Crew(agents=[Agent()])
      crew.kickoff()
    `,
  })
  try {
    const r = runScan(repo)
    const c = r.candidates[0]
    assert.equal(c.is_workflow_entry, true)
    assert.ok(c.workflow_patterns.includes('crewai-crew'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('workflow: AutoGen GroupChatManager recognised', () => {
  const repo = makeRepo({
    'svc.py': `
      from autogen import GroupChat, GroupChatManager
      mgr = GroupChatManager(groupchat=GroupChat([], []))
    `,
  })
  try {
    const r = runScan(repo)
    assert.ok(r.candidates[0].is_workflow_entry)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('workflow: Mastra Agent JS recognised', () => {
  const repo = makeRepo({
    'svc.ts': `
      import { Agent } from '@mastra/core/agent'
      const a = new Agent({ name: 'x' })
    `,
  })
  try {
    const r = runScan(repo)
    assert.ok(r.candidates[0].is_workflow_entry)
    assert.ok(r.candidates[0].workflow_patterns.includes('mastra-agent'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('workflow: summary.workflow_entries counts correctly', () => {
  const repo = makeRepo({
    'svc.py':    `from langgraph.graph import StateGraph\ng = StateGraph(int); g.compile()`,
    'helper.py': 'import anthropic\n',
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.workflow_entries, 1)
    assert.ok(r.summary.entry_points >= 1)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── Transitive resolution ──────────────────────────────────────────────

test('transitive: Python file importing a local module that uses LLM SDK is flagged', () => {
  const repo = makeRepo({
    'helpers/llm.py': 'import anthropic\nclient = anthropic.Anthropic()\n',
    'helpers/__init__.py': '',
    'main.py': 'from helpers.llm import client\n',
  })
  try {
    const r = runScan(repo)
    const main = r.candidates.find(c => c.path === 'main.py')
    assert.ok(main, 'main.py should be flagged via transitive resolution')
    assert.equal(main.transitive, true)
    // evidence carries the via_file pointer
    assert.ok(main.evidence.some(e => e.via_file === 'helpers/llm.py'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('transitive: JS file importing local helper is flagged', () => {
  const repo = makeRepo({
    'src/lib/llm.ts': `import OpenAI from 'openai'\nexport const client = new OpenAI()`,
    'src/main.ts':    `import { client } from './lib/llm'\nclient.chat.completions.create({})`,
  })
  try {
    const r = runScan(repo)
    const main = r.candidates.find(c => c.path === 'src/main.ts')
    assert.ok(main, 'src/main.ts should be flagged')
    assert.equal(main.transitive, true)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('transitive: direct import wins over transitive (no double-counting)', () => {
  const repo = makeRepo({
    'helpers.py': 'import anthropic\n',
    'main.py':    'import anthropic\nfrom helpers import *\n',
  })
  try {
    const r = runScan(repo)
    const main = r.candidates.find(c => c.path === 'main.py')
    assert.ok(main)
    assert.notEqual(main.transitive, true, 'main has its own import — should not be flagged as transitive')
    // Both main.py and helpers.py appear as direct-import candidates.
    assert.equal(r.summary.total, 2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('transitive: does not loop through cycles', () => {
  const repo = makeRepo({
    'a.py': 'import anthropic\nfrom b import x\n',
    'b.py': 'from a import y\n',
  })
  try {
    const r = runScan(repo)
    // a.py is direct-import; b.py is transitive via a → both flagged, no infinite loop.
    assert.ok(r.summary.total >= 1)
    const a = r.candidates.find(c => c.path === 'a.py')
    assert.ok(a)
    assert.notEqual(a.transitive, true)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('transitive: third-party imports are NOT followed as transitive sources', () => {
  // `from anthropic import X` should not turn into a "transitive" edge
  // (anthropic isn't in our local file tree).
  const repo = makeRepo({
    'main.py': `from anthropic import Anthropic\n`,
  })
  try {
    const r = runScan(repo)
    const main = r.candidates[0]
    assert.notEqual(main.transitive, true)
    assert.equal(main.framework, 'anthropic')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
