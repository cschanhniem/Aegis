/**
 * Tool-surface extraction tests. The scanner now extracts the agent's
 * actual tool inventory so the policy generator can ground on it.
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
  const dir = mkdtempSync(join(tmpdir(), 'aegis-tool-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

function runScan(dir) {
  return JSON.parse(execFileSync('node', [SCANNER, dir, '--json'], { encoding: 'utf8' }))
}

test('extracts OpenAI function-call spec tool names', () => {
  const repo = makeRepo({
    'main.py': `
      import openai
      tools = [
        {"name": "db_query", "description": "Query the customer database", "parameters": {"type": "object"}},
        {"name": "send_email", "description": "Send an email", "parameters": {"type": "object"}},
      ]
    `,
  })
  try {
    const r = runScan(repo)
    const names = r.tool_inventory.map(t => t.name).sort()
    assert.deepEqual(names, ['db_query', 'send_email'])
    assert.equal(r.summary.tools_declared, 2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('extracts LangChain Tool(name=...) declarations', () => {
  const repo = makeRepo({
    'main.py': `
      from langchain.tools import Tool
      web_tool = Tool(name="web_search", func=lambda q: q)
      db_tool  = Tool(name="db_query", func=lambda q: q)
    `,
  })
  try {
    const r = runScan(repo)
    const names = r.tool_inventory.map(t => t.name).sort()
    assert.ok(names.includes('web_search'))
    assert.ok(names.includes('db_query'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('extracts @tool decorator function names', () => {
  const repo = makeRepo({
    'main.py': `
      from langchain.tools import tool
      @tool
      def search_docs(query: str) -> str:
          """Search internal docs."""
          return ""

      @tool
      async def send_message(to: str, body: str) -> str:
          return ""
    `,
  })
  try {
    const r = runScan(repo)
    const names = r.tool_inventory.map(t => t.name).sort()
    assert.ok(names.includes('search_docs'))
    assert.ok(names.includes('send_message'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('extracts Vercel AI SDK / Mastra tools object keys', () => {
  const repo = makeRepo({
    'agent.ts': `
      import { streamText, tool } from 'ai'
      const result = await streamText({
        tools: {
          weather: tool({ description: 'Get weather' }),
          searchDocs: tool({ description: 'Search docs' }),
        },
      })
    `,
  })
  try {
    const r = runScan(repo)
    const names = r.tool_inventory.map(t => t.name).sort()
    assert.ok(names.includes('weather'))
    assert.ok(names.includes('searchDocs'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('repo-level tool_inventory dedupes across files', () => {
  const repo = makeRepo({
    'a.py': `
      from langchain.tools import Tool
      x = Tool(name="db_query", func=lambda q: q)
    `,
    'b.py': `
      from langchain.tools import Tool
      y = Tool(name="db_query", func=lambda q: q)
    `,
  })
  try {
    const r = runScan(repo)
    const dbQ = r.tool_inventory.filter(t => t.name === 'db_query')
    assert.equal(dbQ.length, 1)
    assert.equal(dbQ[0].sources.length, 2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('MCP server names enter the inventory under shape=mcp', () => {
  const repo = makeRepo({
    'claude_desktop_config.json': JSON.stringify({
      mcpServers: {
        'github':     { command: 'mcp-github' },
        'filesystem': { command: 'mcp-fs' },
      },
    }),
  })
  try {
    const r = runScan(repo)
    const mcp = r.tool_inventory.filter(t => t.shape === 'mcp').map(t => t.name).sort()
    assert.deepEqual(mcp, ['filesystem', 'github'])
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('does NOT misread comments / docstrings as tool declarations', () => {
  const repo = makeRepo({
    'main.py': `
      """We have a tool called secret_tool but it's deprecated."""
      # tools = [{"name": "ghost_tool"}]   # not real
      import openai
    `,
  })
  try {
    const r = runScan(repo)
    // No tools_declared (the comment + docstring aren't object literals).
    assert.equal(r.tool_inventory.length, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('does NOT extract names from objects without "description" field', () => {
  // FP guard: { "name": "rabbit" } in a config file shouldn't be tagged
  // as a function-call tool unless it ALSO has a description.
  const repo = makeRepo({
    'cfg.py': `
      pets = [{"name": "rabbit", "color": "white"}, {"name": "cat", "color": "black"}]
      import openai
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.tool_inventory.length, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('candidates carry per-file tools_declared', () => {
  const repo = makeRepo({
    'main.py': `
      import openai
      tools = [{"name": "db_query", "description": "Query DB", "parameters": {}}]
    `,
  })
  try {
    const r = runScan(repo)
    const main = r.candidates.find(c => c.path === 'main.py')
    assert.ok(main.tools_declared)
    assert.equal(main.tools_declared.length, 1)
    assert.equal(main.tools_declared[0].name, 'db_query')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('inventory entries record first_seen_in + sources', () => {
  const repo = makeRepo({
    'svc/a.py': `
      import openai
      tools = [{"name": "shared_tool", "description": "x", "parameters": {}}]
    `,
    'svc/b.py': `
      import openai
      tools = [{"name": "shared_tool", "description": "x", "parameters": {}}]
    `,
  })
  try {
    const r = runScan(repo)
    const entry = r.tool_inventory.find(t => t.name === 'shared_tool')
    assert.ok(entry)
    assert.equal(entry.sources.length, 2)
    assert.ok(entry.first_seen_in.endsWith('.py'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
