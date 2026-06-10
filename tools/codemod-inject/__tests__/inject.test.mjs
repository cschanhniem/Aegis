/**
 * Codemod injector tests. Build tiny files, run --dry-run + --write,
 * assert the rewritten file (a) inserts at the right spot, (b) doesn't
 * break the shebang / docstring / __future__ / 'use strict' invariants,
 * (c) is idempotent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const INJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')

function makeFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-inject-'))
  const full = join(dir, name)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return { dir, full }
}

function run(args) {
  return execFileSync('node', [INJECT, ...args], { encoding: 'utf8' })
}

function runWriteFile(path) {
  const out = run(['--file', path, '--language', path.endsWith('.py') ? 'python' : 'javascript', '--write', '--agent-id', 'test-agent', '--gateway', 'http://localhost:8080', '--api-key', 'aegis_test_xxx'])
  return JSON.parse(out)
}

test('Python: inserts after module docstring + __future__ imports', () => {
  const src = `"""My module docstring.

Multi-line.
"""
from __future__ import annotations

import os
import anthropic
`
  const { full } = makeFile('main.py', src)
  try {
    runWriteFile(full)
    const out = readFileSync(full, 'utf8')
    const lines = out.split('\n')
    // Verify docstring and future import remain at the top.
    assert.ok(lines[0].startsWith('"""'))
    assert.ok(out.includes('from __future__ import annotations'))
    // Find AEGIS block — must come after the future import.
    const aegisLine = lines.findIndex(l => l.startsWith('import agentguard'))
    const futureLine = lines.findIndex(l => l.includes('from __future__'))
    assert.ok(aegisLine > futureLine, `aegis (${aegisLine}) must come after futures (${futureLine})`)
    // import os / anthropic still in tact, after our snippet
    assert.ok(out.includes('import os\n'))
    assert.ok(out.includes('import anthropic'))
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('Python: preserves shebang + encoding header', () => {
  const src = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import openai
`
  const { full } = makeFile('cli.py', src)
  try {
    runWriteFile(full)
    const out = readFileSync(full, 'utf8')
    const lines = out.split('\n')
    assert.equal(lines[0], '#!/usr/bin/env python3')
    assert.equal(lines[1], '# -*- coding: utf-8 -*-')
    // Inject after the encoding line, before openai import
    const aegisLine = lines.findIndex(l => l.startsWith('import agentguard'))
    const openaiLine = lines.findIndex(l => l === 'import openai')
    assert.ok(aegisLine > 1 && aegisLine < openaiLine)
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('Python: handles single-line docstring', () => {
  const src = `"""one-liner module doc."""
import anthropic
`
  const { full } = makeFile('app.py', src)
  try {
    runWriteFile(full)
    const out = readFileSync(full, 'utf8')
    const lines = out.split('\n')
    assert.equal(lines[0], '"""one-liner module doc."""')
    const aegis = lines.findIndex(l => l.startsWith('import agentguard'))
    assert.ok(aegis >= 1)
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('Python: idempotent — re-running on an already-protected file is a no-op', () => {
  const src = `import openai\n`
  const { full } = makeFile('idem.py', src)
  try {
    runWriteFile(full)
    const after1 = readFileSync(full, 'utf8')
    runWriteFile(full)
    const after2 = readFileSync(full, 'utf8')
    assert.equal(after1, after2)
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('Python: backup file written for revert', () => {
  const src = `import anthropic\n`
  const { full } = makeFile('back.py', src)
  try {
    runWriteFile(full)
    assert.ok(existsSync(full + '.aegis.bak'))
    assert.equal(readFileSync(full + '.aegis.bak', 'utf8'), src)
    // Revert restores
    run(['--revert', full])
    assert.equal(readFileSync(full, 'utf8'), src)
    assert.ok(!existsSync(full + '.aegis.bak'))
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('JS: inserts after "use strict" directive', () => {
  const src = `'use strict';
const x = 1;
import OpenAI from 'openai';
`
  const { full } = makeFile('app.js', src)
  try {
    runWriteFile(full)
    const out = readFileSync(full, 'utf8')
    const lines = out.split('\n')
    assert.equal(lines[0], `'use strict';`)
    const aegis = lines.findIndex(l => l.startsWith(`import agentguard`))
    const useStrict = lines.findIndex(l => l.includes("'use strict'"))
    const openai    = lines.findIndex(l => l.startsWith('import OpenAI'))
    assert.ok(useStrict < aegis && aegis < openai, `aegis (${aegis}) must sit between use-strict (${useStrict}) and import (${openai})`)
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('TS: preserves triple-slash reference directives', () => {
  const src = `/// <reference types="node" />
import OpenAI from 'openai';
`
  const { full } = makeFile('server.ts', src)
  try {
    runWriteFile(full)
    const out = readFileSync(full, 'utf8')
    const lines = out.split('\n')
    assert.equal(lines[0], `/// <reference types="node" />`)
    const aegis = lines.findIndex(l => l.startsWith('import agentguard'))
    const openai = lines.findIndex(l => l.startsWith('import OpenAI'))
    assert.ok(aegis > 0 && aegis < openai)
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('dry-run by default — no write happens without --write', () => {
  const src = `import openai\n`
  const { full } = makeFile('dry.py', src)
  try {
    const stdout = run(['--file', full, '--language', 'python', '--agent-id', 'a', '--gateway', 'http://localhost:8080'])
    const after = readFileSync(full, 'utf8')
    assert.equal(after, src, 'file should not change in dry-run')
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.mode, 'dry-run')
    assert.equal(parsed.results.length, 1)
    assert.ok(!existsSync(full + '.aegis.bak'))
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})

test('report-mode: skips http + mcp + Go candidates with remediation hints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-inject-mixed-'))
  try {
    const pyFile = join(dir, 'a.py')
    const goFile = join(dir, 'b.go')
    const httpFile = join(dir, 'c.py')
    const mcpFile  = join(dir, 'mcp.json')
    writeFileSync(pyFile,   'import openai\n')
    writeFileSync(goFile,   'package main\nimport "github.com/sashabaranov/go-openai"\n')
    writeFileSync(httpFile, `URL = "https://api.openai.com/v1/chat/completions"\n`)
    writeFileSync(mcpFile,  '{"mcpServers":{"fs":{"command":"x"}}}')

    const reportPath = join(dir, 'scan.json')
    const report = {
      root: dir,
      candidates: [
        { kind: 'import', abs_path: pyFile,   language: 'python',     framework: 'openai',      suggested_agent_id: 'py-bot',   is_entry_point: true,  already_protected: false, remediation: { action: 'sdk-inject',   note: 'inject' } },
        { kind: 'import', abs_path: goFile,   language: 'go',         framework: 'openai-go',   suggested_agent_id: 'go-bot',   is_entry_point: true,  already_protected: false, remediation: { action: 'sdk-inject',   note: 'inject' } },
        { kind: 'http',   abs_path: httpFile, language: 'python',     framework: 'openai-http', suggested_agent_id: 'http-bot', is_entry_point: false, already_protected: false, remediation: { action: 'egress-proxy', note: 'use proxy' } },
        { kind: 'mcp',    abs_path: mcpFile,  language: 'config',     framework: 'mcp-config',  suggested_agent_id: 'mcp-bot',  is_entry_point: false, already_protected: false, mcp_server: 'fs', remediation: { action: 'mcp-proxy', note: 'wire mcp proxy' } },
      ],
    }
    writeFileSync(reportPath, JSON.stringify(report))
    const stdout = run(['--report', reportPath, '--gateway', 'http://localhost:8080', '--write'])
    const parsed = JSON.parse(stdout)

    // Only the Python row should have been written; Go/http/mcp are
    // recorded as skip-with-remediation.
    const written = parsed.results.filter((r) => r.file && !r.skipped)
    assert.equal(written.length, 1)
    assert.equal(written[0].file, pyFile)

    const skipped = parsed.results.filter((r) => r.skipped)
    assert.equal(skipped.length, 3)
    const byKind = Object.fromEntries(skipped.map((s) => [s.kind, s]))
    assert.equal(byKind.import.reason, "language 'go' not auto-injectable in v1")
    assert.equal(byKind.http.reason,   'egress-proxy')
    assert.equal(byKind.mcp.reason,    'mcp-proxy')

    // The Go file must NOT have been edited.
    const goAfter = readFileSync(goFile, 'utf8')
    assert.ok(!goAfter.includes('agentguard'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('snippet uses operator-supplied gateway, agent_id, api_key', () => {
  const src = `import anthropic\n`
  const { full } = makeFile('cfg.py', src)
  try {
    run(['--file', full, '--language', 'python', '--write',
         '--gateway', 'https://aegis.corp.example/v1',
         '--agent-id', 'finance-report-bot',
         '--api-key', 'aegis_a_abc123'])
    const out = readFileSync(full, 'utf8')
    assert.ok(out.includes('https://aegis.corp.example/v1'))
    assert.ok(out.includes('agent_id="finance-report-bot"'))
    assert.ok(out.includes('api_key="aegis_a_abc123"'))
  } finally { rmSync(dirname(full), { recursive: true, force: true }) }
})
