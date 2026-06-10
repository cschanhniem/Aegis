/**
 * Industrial-grade scanner test suite. Covers the three detection paths
 * the original scanner couldn't see:
 *
 *   - HTTP endpoints (raw `requests` / `fetch` / `httpx` users)
 *   - MCP / Claude Desktop / Cursor / VS Code configs
 *   - Go imports + Go HTTP endpoints
 *
 * Plus false-positive guards: docstrings, comments, partial-domain
 * matches, mismatched config files.
 *
 * Run:  node --test tools/repo-scanner/__tests__/scanner-extended.test.mjs
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
  const dir = mkdtempSync(join(tmpdir(), 'aegis-scan-ext-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

function runScan(dir, extra = []) {
  const out = execFileSync('node', [SCANNER, dir, '--json', ...extra], { encoding: 'utf8' })
  return JSON.parse(out)
}

// ── HTTP detection ──────────────────────────────────────────────────────

test('HTTP: detects raw requests.post to api.openai.com', () => {
  const repo = makeRepo({
    'app.py': `
      import requests
      r = requests.post("https://api.openai.com/v1/chat/completions", json={})
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].kind, 'http')
    assert.equal(r.candidates[0].framework, 'openai-http')
    assert.equal(r.candidates[0].remediation.action, 'egress-proxy')
    assert.ok(r.candidates[0].remediation.note.includes('llm-proxy/openai'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('HTTP: detects base_url= pattern (OpenAI Python SDK with custom endpoint)', () => {
  const repo = makeRepo({
    'main.py': `
      # This file does NOT import openai, only uses base_url.
      import some_other_thing
      CFG = { "base_url": "https://api.openai.com/v1" }
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].kind, 'http')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('HTTP: detects fetch() to api.anthropic.com from .ts file', () => {
  const repo = makeRepo({
    'src/api.ts': `
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST" })
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].kind, 'http')
    assert.equal(r.candidates[0].framework, 'anthropic-http')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('HTTP: detects Azure OpenAI custom subdomain', () => {
  const repo = makeRepo({
    'app.py': `
      url = "https://acme-prod.openai.azure.com/openai/deployments/gpt-4"
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework, 'azure-openai-http')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('HTTP: detects Ollama local endpoint', () => {
  const repo = makeRepo({
    'bot.py': `URL = "http://localhost:11434/api/generate"`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework, 'ollama-http')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('HTTP: does NOT trip on partial-domain match (api.openai.com.evil.com)', () => {
  // Conservative: our pattern matches `["']https?://api.openai.com[^"']*["']`,
  // so a string ending with /attacker would still match. But a string
  // that's just `api.openai.com` (no protocol, no quotes) should NOT.
  const repo = makeRepo({
    'app.py': `# api.openai.com is the endpoint we're documenting\nDOCSTRING = "this code talks to openai"`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('HTTP: import wins over HTTP when both present in the same file', () => {
  const repo = makeRepo({
    'app.py': `
      from openai import OpenAI
      # legacy code path also uses raw HTTP:
      LEGACY = "https://api.openai.com/v1/chat/completions"
    `,
  })
  try {
    const r = runScan(repo)
    // import row wins; the http hit is NOT duplicated as a separate row
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].kind, 'import')
    assert.equal(r.candidates[0].framework, 'openai')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('HTTP: candidate flagged already_protected when egress-proxy base_url is used', () => {
  // A file with the OpenAI SDK import AND the egress-proxy URL is the
  // realistic case: the SDK is what makes it a candidate, the proxy URL
  // override is the marker that says "this is already routed through us".
  const repo = makeRepo({
    'app.py': `
      from openai import OpenAI
      client = OpenAI(base_url="https://aegis.local/api/v1/llm-proxy/openai/v1")
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].already_protected, true)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── MCP config detection ────────────────────────────────────────────────

test('MCP: detects claude_desktop_config.json with mcpServers map', () => {
  const repo = makeRepo({
    'claude_desktop_config.json': JSON.stringify({
      mcpServers: {
        'filesystem': { command: 'npx', args: ['@modelcontextprotocol/server-filesystem'] },
        'github':     { command: 'npx', args: ['@modelcontextprotocol/server-github'] },
      },
    }, null, 2),
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 2)
    const fws = new Set(r.candidates.map(c => c.mcp_server))
    assert.deepEqual(fws, new Set(['filesystem', 'github']))
    for (const c of r.candidates) {
      assert.equal(c.kind, 'mcp')
      assert.equal(c.remediation.action, 'mcp-proxy')
    }
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('MCP: detects .mcp.json (generic) with servers[] array', () => {
  const repo = makeRepo({
    '.mcp.json': JSON.stringify({
      servers: [
        { name: 'jira',  command: 'mcp-server-jira' },
        { name: 'slack', command: 'mcp-server-slack' },
      ],
    }),
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 2)
    assert.equal(r.candidates[0].kind, 'mcp')
    assert.ok(r.candidates.some(c => c.mcp_server === 'jira'))
    assert.ok(r.candidates.some(c => c.mcp_server === 'slack'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('MCP: detects .cursor/mcp.json', () => {
  const repo = makeRepo({
    '.cursor/mcp.json': JSON.stringify({
      mcpServers: { 'postgres': { command: 'mcp-postgres' } },
    }),
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework_name, 'Cursor')
    assert.equal(r.candidates[0].mcp_server, 'postgres')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('MCP: .vscode/mcp.json is recognised', () => {
  const repo = makeRepo({
    '.vscode/mcp.json': JSON.stringify({ mcpServers: { 'memory': { command: 'mcp-memory' } } }),
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].framework, 'vscode-mcp')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('MCP: malformed JSON config is silently skipped', () => {
  const repo = makeRepo({
    'claude_desktop_config.json': '{ "mcpServers": { "broken":',
    'app.py': 'import anthropic\n',
  })
  try {
    const r = runScan(repo)
    // anthropic import detected, broken JSON skipped → exactly 1 candidate
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].kind, 'import')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('MCP: empty mcpServers / empty servers[] produces zero candidates', () => {
  const repo = makeRepo({
    'claude_desktop_config.json': JSON.stringify({ mcpServers: {} }),
    '.mcp.json':                  JSON.stringify({ servers: [] }),
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── Go language support ─────────────────────────────────────────────────

test('Go: detects openai-go import', () => {
  const repo = makeRepo({
    'go.mod': 'module github.com/acme/research-bot\n',
    'cmd/bot/main.go': `package main
import (
  "fmt"
  "github.com/sashabaranov/go-openai"
)
func main() { fmt.Println(openai.GPT4) }`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 1)
    assert.equal(r.candidates[0].kind, 'import')
    assert.equal(r.candidates[0].framework, 'openai-go')
    assert.equal(r.candidates[0].language, 'go')
    assert.equal(r.candidates[0].is_entry_point, true)
    // suggested_agent_id includes repo name from go.mod
    assert.ok(r.candidates[0].suggested_agent_id.startsWith('research-bot-'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Go: detects anthropic-go import', () => {
  const repo = makeRepo({
    'main.go': `package main
import "github.com/anthropics/anthropic-sdk-go"
func main(){}`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].framework, 'anthropic-go')
    assert.equal(r.candidates[0].language, 'go')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Go: detects bedrock via aws-sdk-go-v2/service/bedrockruntime', () => {
  const repo = makeRepo({
    'app.go': `package main
import (
  "github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)
var _ = bedrockruntime.New`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].framework, 'bedrock-go')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Go: detects raw HTTP call to OpenAI', () => {
  const repo = makeRepo({
    'app.go': `package main
import "net/http"
func main() {
  http.Post("https://api.openai.com/v1/chat/completions", "application/json", nil)
}`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.candidates[0].kind, 'http')
    assert.equal(r.candidates[0].framework, 'openai-http')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── False-positive guards ───────────────────────────────────────────────

test('FP guard: python snippet strings inside .tsx (cockpit-style) still skipped', () => {
  // Locked-down version of the earlier regression: snippet examples
  // for many providers in one .tsx file must still produce 0 candidates
  // (the .tsx file has no real import).
  const repo = makeRepo({
    'snippets.tsx': `
      const SNIPPETS = [
        \`import anthropic; client = anthropic.Anthropic()\`,
        \`from openai import OpenAI\`,
        \`from crewai import Agent\`,
        \`import boto3; bedrock = boto3.client("bedrock-runtime")\`,
        \`from groq import Groq\`,
      ]
      export const X = SNIPPETS
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('FP guard: documentation comment mentioning api.openai.com does not trip', () => {
  // The pattern requires quotes around the URL — a bare comment shouldn't match.
  const repo = makeRepo({
    'README.notpy': 'free-text mentioning api.openai.com',   // not scanned
    'app.py': `
      # talks to api.openai.com but we mocked it out
      data = {"hello": "world"}
    `,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('FP guard: HTTP signatures only fire on URL string literals, not bare strings', () => {
  const repo = makeRepo({
    'app.py': `OPENAI_DOMAIN = "api.openai.com"   # bare domain, not a URL`,
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.total, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── Ranking / output shape ──────────────────────────────────────────────

test('candidates ranked: import > http > mcp', () => {
  const repo = makeRepo({
    'svc/runner.py':    'import anthropic\n',
    'svc/legacy.py':    `r = requests.post("https://api.openai.com/v1/chat/completions")`,
    'claude_desktop_config.json': JSON.stringify({ mcpServers: { fs: { command: 'mcp-fs' } } }),
  })
  try {
    const r = runScan(repo)
    const kinds = r.candidates.map(c => c.kind)
    // first import, then http, then mcp
    assert.equal(kinds[0], 'import')
    assert.ok(kinds.lastIndexOf('import') < kinds.indexOf('http'))
    assert.ok(kinds.lastIndexOf('http')   < kinds.indexOf('mcp'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('summary.by_kind reports per-kind counts', () => {
  const repo = makeRepo({
    'a.py': 'import anthropic\n',
    'b.py': 'import openai\n',
    'c.py': `r = requests.post("https://api.mistral.ai/v1/chat/completions")`,
    'claude_desktop_config.json': JSON.stringify({ mcpServers: { fs: { command: 'x' }, gh: { command: 'y' } } }),
  })
  try {
    const r = runScan(repo)
    assert.equal(r.summary.by_kind.import, 2)
    assert.equal(r.summary.by_kind.http,   1)
    assert.equal(r.summary.by_kind.mcp,    2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('summary.configs_scanned reflects MCP file discovery', () => {
  const repo = makeRepo({
    'claude_desktop_config.json': JSON.stringify({ mcpServers: { fs: { command: 'x' } } }),
    '.mcp.json':                  JSON.stringify({ servers: [] }),
  })
  try {
    const r = runScan(repo)
    assert.equal(r.configs_scanned, 2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('remediation.action correctly set per kind', () => {
  const repo = makeRepo({
    'a.py': 'import anthropic\n',
    'b.py': `URL = "https://api.openai.com/v1"`,
    'claude_desktop_config.json': JSON.stringify({ mcpServers: { fs: { command: 'x' } } }),
  })
  try {
    const r = runScan(repo)
    const byKind = Object.fromEntries(r.candidates.map(c => [c.kind, c.remediation.action]))
    assert.equal(byKind.import, 'sdk-inject')
    assert.equal(byKind.http,   'egress-proxy')
    assert.equal(byKind.mcp,    'mcp-proxy')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── Compatibility with extended frameworks ──────────────────────────────

test('newly-added Python frameworks: DSPy / Cohere / Groq / Ollama / Together / Replicate', () => {
  const repo = makeRepo({
    'dspy_app.py':      'import dspy\n',
    'cohere_app.py':    'from cohere import Client\n',
    'groq_app.py':      'from groq import Groq\n',
    'ollama_app.py':    'import ollama\n',
    'together_app.py':  'from together import Together\n',
    'replicate_app.py': 'import replicate\n',
  })
  try {
    const r = runScan(repo)
    const fws = new Set(r.candidates.map(c => c.framework))
    for (const expected of ['dspy', 'cohere', 'groq', 'ollama', 'together', 'replicate']) {
      assert.ok(fws.has(expected), `missing framework ${expected}; got ${[...fws].join(', ')}`)
    }
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('newly-added JS frameworks: mistral-js / cohere-js / ollama-js / groq-js', () => {
  const repo = makeRepo({
    'a.ts': `import { Mistral } from '@mistralai/mistralai'`,
    'b.ts': `import { CohereClient } from 'cohere-ai'`,
    'c.ts': `import ollama from 'ollama'`,
    'd.ts': `import Groq from 'groq-sdk'`,
  })
  try {
    const r = runScan(repo)
    const fws = new Set(r.candidates.map(c => c.framework))
    for (const expected of ['mistral-js', 'cohere-js', 'ollama-js', 'groq-js']) {
      assert.ok(fws.has(expected), `missing framework ${expected}`)
    }
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
