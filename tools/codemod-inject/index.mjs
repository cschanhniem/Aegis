#!/usr/bin/env node
/**
 * AEGIS codemod injector.
 *
 * Reads a scan report (produced by tools/repo-scanner) and inserts the
 * AEGIS bootstrap snippet at the top of each entry file, after the
 * shebang / encoding / docstring / __future__ imports / "use strict"
 * directives. Idempotent: re-running on an already-protected file is a
 * no-op.
 *
 * Operates in three modes:
 *
 *   --dry-run (default)   prints a unified diff per file, writes nothing
 *   --write               applies the edits in place after backing the
 *                         file up to <file>.aegis.bak
 *   --revert              restores .aegis.bak files
 *
 * Inputs (mutually exclusive):
 *
 *   --report <path>       JSON report from repo-scanner (preferred —
 *                         pulls suggested_agent_id, language, etc.)
 *   --file <path>         Single file path (use with --language).
 *
 * Common flags:
 *
 *   --gateway <url>       Default: http://localhost:8080
 *   --api-key <key>       Embedded inline (literal); fall back to env
 *   --only-entry-points   Only inject into files where is_entry_point=true
 *   --skip-protected      Skip already_protected files (on by default)
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { resolve, basename, extname, dirname } from 'node:path'

const BANNER = '# === AEGIS auto-instrumentation ==='
const BANNER_JS = '// === AEGIS auto-instrumentation ==='

function readArgs(argv) {
  const out = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--write') out.write = true
    else if (a === '--revert') out.revert = true
    else if (a === '--only-entry-points') out.onlyEntryPoints = true
    else if (a === '--include-protected') out.includeProtected = true
    else if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : 'true'
      out[k] = v
    } else out.positional.push(a)
  }
  if (!out.write && !out.revert) out.dryRun = true
  return out
}

function isProtected(text) {
  return (
    /^\s*import\s+agentguard\b/m.test(text)
    || /from\s+["']@justinnn\/agentguard["']/.test(text)
    || /require\(\s*["']@justinnn\/agentguard["']\s*\)/.test(text)
    || /agentguard\.(auto|Auto)\s*\(/.test(text)
  )
}

/** Find the line index (0-based) where we should insert. The first line
 *  of "real code" — after shebang, encoding header, top-level docstring,
 *  __future__ imports, and 'use strict' directives. */
function findInsertionPoint(lines, language) {
  let i = 0

  // Shebang
  if (lines[i]?.startsWith('#!')) i++

  if (language === 'python') {
    // Encoding declaration (PEP 263, may be on line 1 or 2)
    if (i < 2 && /coding[:=]\s*[-\w.]+/.test(lines[i] ?? '')) i++

    // Skip blank lines + line comments
    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++

    // Skip module docstring (triple-quoted string at top)
    const docMatch = lines[i]?.match(/^\s*(['"]{3})/)
    if (docMatch) {
      const quote = docMatch[1]
      // Single-line docstring on the same line as the opening?
      const same = lines[i].slice(lines[i].indexOf(quote) + 3).includes(quote)
      i++
      if (!same) {
        while (i < lines.length && !lines[i].includes(quote)) i++
        if (i < lines.length) i++   // consume the line containing the closing quote
      }
    }

    // Skip __future__ imports (PEP 236 requires them to be at top of module)
    while (
      i < lines.length
      && (lines[i].trim() === ''
          || lines[i].trim().startsWith('#')
          || /^\s*from\s+__future__\s+import/.test(lines[i]))
    ) i++
  } else {
    // JavaScript / TypeScript
    // Skip leading comments + blanks
    while (
      i < lines.length
      && (lines[i].trim() === ''
          || lines[i].trim().startsWith('//')
          || lines[i].trim().startsWith('/*'))
    ) i++

    // Skip 'use strict' directive
    if (/^\s*["']use strict["'];?\s*$/.test(lines[i] ?? '')) i++
    // Skip /// <reference ...> triple-slash directives (TS)
    while (i < lines.length && /^\s*\/\/\/\s*<reference/.test(lines[i])) i++
  }
  return i
}

function buildPythonSnippet(opts) {
  const { gatewayUrl, agentId, apiKey } = opts
  const kwArgs = [`"${gatewayUrl}"`, `agent_id="${agentId}"`]
  if (apiKey) kwArgs.push(`api_key="${apiKey}"`)
  return [
    BANNER,
    'import agentguard',
    `agentguard.auto(${kwArgs.join(', ')})`,
    '# === /AEGIS ===',
    '',
  ]
}

function buildJsSnippet(opts) {
  const { gatewayUrl, agentId, apiKey } = opts
  const cfg = [`agentId: '${agentId}'`]
  if (apiKey) cfg.push(`apiKey: '${apiKey}'`)
  return [
    BANNER_JS,
    `import agentguard from '@justinnn/agentguard'`,
    `agentguard.auto('${gatewayUrl}', { ${cfg.join(', ')} })`,
    '// === /AEGIS ===',
    '',
  ]
}

function plan(file, language, opts) {
  if (!existsSync(file)) return { ok: false, error: 'file not found' }
  const text = readFileSync(file, 'utf8')
  if (isProtected(text)) return { ok: true, skipped: true, reason: 'already protected', file }

  const lines = text.split(/\r?\n/)
  const insertAt = findInsertionPoint(lines, language)
  const snippet  = language === 'python' ? buildPythonSnippet(opts) : buildJsSnippet(opts)
  const next     = [...lines.slice(0, insertAt), ...snippet, ...lines.slice(insertAt)]

  return {
    ok: true,
    file,
    language,
    insertAt,
    original: text,
    modified: next.join('\n'),
    diff: makeDiff(file, lines, next, insertAt, snippet.length),
  }
}

function makeDiff(file, before, after, insertAt, hunkLen) {
  // Tiny unified-diff approximation. Sufficient for human review; the
  // operator should run `git diff` post-write for a real diff.
  const ctxBefore = before.slice(Math.max(0, insertAt - 2), insertAt)
  const inserted  = after.slice(insertAt, insertAt + hunkLen)
  const ctxAfter  = after.slice(insertAt + hunkLen, insertAt + hunkLen + 2)
  const out = []
  out.push(`--- a/${file}`)
  out.push(`+++ b/${file}`)
  out.push(`@@ -${Math.max(1, insertAt - 1)},${ctxBefore.length + ctxAfter.length} +${Math.max(1, insertAt - 1)},${ctxBefore.length + hunkLen + ctxAfter.length} @@`)
  for (const l of ctxBefore) out.push(` ${l}`)
  for (const l of inserted)  out.push(`+${l}`)
  for (const l of ctxAfter)  out.push(` ${l}`)
  return out.join('\n')
}

function applyEdit(p) {
  // Backup → write
  const backup = p.file + '.aegis.bak'
  if (!existsSync(backup)) writeFileSync(backup, p.original)
  writeFileSync(p.file, p.modified)
}

function revertFile(file) {
  const backup = file + '.aegis.bak'
  if (!existsSync(backup)) return { ok: false, reason: 'no backup' }
  renameSync(backup, file)
  return { ok: true }
}

function main(argv) {
  const args = readArgs(argv.slice(2))
  const gatewayUrl = args['gateway'] ?? process.env.AEGIS_GATEWAY_URL ?? 'http://localhost:8080'
  const apiKey     = args['api-key'] ?? process.env.AEGIS_API_KEY ?? ''

  if (args.revert) {
    const files = args.positional.length ? args.positional : (args.report ? readReport(args.report).candidates.map(c => c.abs_path) : [])
    const results = []
    for (const f of files) {
      const r = revertFile(f)
      console.error(r.ok ? `↺ reverted ${f}` : `– skip   ${f} (${r.reason})`)
      results.push({ ok: r.ok, file: f, skipped: !r.ok, reason: r.reason })
    }
    process.stdout.write(JSON.stringify({ mode: 'revert', results }, null, 2) + '\n')
    return
  }

  let targets = []
  const skipsForRemediation = []   // candidates we can't inject (http / mcp / go) but should report
  // Languages the codemod can rewrite in-place. Go SDK use is a real
  // import but the AST-level work of inserting an extra import line +
  // init() func in Go is out of scope for v1 — we instead emit a clear
  // remediation hint so the operator wires the SDK by hand.
  const INJECTABLE_LANGS = new Set(['python', 'javascript'])
  if (args.report) {
    const report = readReport(args.report)
    for (const c of report.candidates) {
      const kind = c.kind ?? 'import'
      if (kind !== 'import') {
        skipsForRemediation.push({
          ok: true,
          skipped: true,
          file: c.abs_path,
          kind,
          reason: c.remediation?.action ?? 'non-injectable',
          remediation: c.remediation?.note ?? 'not an SDK import — handle out-of-band',
          framework: c.framework,
        })
        continue
      }
      if (!INJECTABLE_LANGS.has(c.language)) {
        skipsForRemediation.push({
          ok: true,
          skipped: true,
          file: c.abs_path,
          kind: 'import',
          reason: `language '${c.language}' not auto-injectable in v1`,
          remediation: `Wire the AEGIS ${c.language} SDK by hand — see docs/sdk-${c.language}.md.`,
          framework: c.framework,
          language: c.language,
        })
        continue
      }
      targets.push({
        file:       c.abs_path,
        language:   c.language,
        agentId:    args['agent-id'] ?? c.suggested_agent_id,
        isEntry:    c.is_entry_point,
        protected:  c.already_protected,
      })
    }
  } else if (args.file) {
    targets = [{
      file:      resolve(args.file),
      language:  args.language ?? guessLanguage(args.file),
      agentId:   args['agent-id'] ?? basename(args.file).replace(/\.[^.]+$/, ''),
      isEntry:   true,
      protected: false,
    }]
  } else {
    console.error('Usage: codemod-inject (--report <scan.json> | --file <path> [--language python|javascript])\n' +
                  '  Default mode is --dry-run. Pass --write to apply, --revert to undo.')
    process.exit(2)
  }

  if (args.onlyEntryPoints) targets = targets.filter(t => t.isEntry)
  if (!args.includeProtected) targets = targets.filter(t => !t.protected)

  const results = []
  for (const t of targets) {
    if (!t.language) {
      results.push({ ok: false, file: t.file, reason: 'unknown language' })
      continue
    }
    const p = plan(t.file, t.language, { gatewayUrl, apiKey, agentId: t.agentId })
    if (!p.ok)      { results.push(p); continue }
    if (p.skipped)  { results.push(p); console.error(`– skip   ${t.file} (${p.reason})`); continue }
    if (args.write) {
      applyEdit(p)
      console.error(`✓ wrote  ${t.file}  (agent_id=${t.agentId})`)
    } else {
      console.error(`◇ plan   ${t.file}  (agent_id=${t.agentId})`)
      console.error(p.diff)
      console.error('')
    }
    results.push({ ...p, agentId: t.agentId })
  }

  // Append the non-injectable candidates (http / mcp) verbatim — the
  // wizard renders them with their remediation hint so the operator
  // knows what's pending out of band.
  for (const s of skipsForRemediation) {
    results.push(s)
    console.error(`– skip   ${s.file} (${s.kind} — ${s.reason})`)
  }

  process.stdout.write(JSON.stringify({ mode: args.write ? 'write' : 'dry-run', results }, null, 2) + '\n')
}

function readReport(p) {
  const text = readFileSync(p, 'utf8').trim()
  // Scanner emits the JSON report as the last line in non-JSON mode, or
  // the entire stdout in --json mode. Pick whichever parses.
  const lines = text.split('\n').reverse()
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue
    try { return JSON.parse(line) } catch { /* keep trying */ }
  }
  return JSON.parse(text)
}

function guessLanguage(file) {
  const ext = extname(file).toLowerCase()
  if (ext === '.py') return 'python'
  if (['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(ext)) return 'javascript'
  return null
}

main(process.argv)
