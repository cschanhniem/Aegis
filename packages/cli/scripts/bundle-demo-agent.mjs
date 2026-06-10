#!/usr/bin/env node
// Copies tools/{demo-agent,repo-scanner,codemod-inject} into
// packages/cli/{demo-agent,repo-scanner,codemod-inject} so
// `agentguard demo` / `agentguard scan` keep working when the CLI is
// installed standalone (no monorepo siblings).
//
// The scanner is a multi-file module (index.mjs + signatures.mjs +
// preprocess.mjs + ast-python.mjs + tree-sitter-python.wasm) — copy
// EVERY .mjs and .wasm in its directory, not just index.mjs.
import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg  = resolve(here, '..')

const toolDirs = [
  { src: resolve(pkg, '..', '..', 'tools', 'demo-agent'),     dest: join(pkg, 'demo-agent') },
  { src: resolve(pkg, '..', '..', 'tools', 'repo-scanner'),   dest: join(pkg, 'repo-scanner') },
  { src: resolve(pkg, '..', '..', 'tools', 'codemod-inject'), dest: join(pkg, 'codemod-inject') },
]

for (const { src, dest } of toolDirs) {
  if (!existsSync(src)) {
    console.warn(`[bundle] source missing: ${src} — skipping.`)
    continue
  }
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    if (entry.endsWith('.mjs') || entry.endsWith('.wasm')) {
      copyFileSync(join(src, entry), join(dest, entry))
      console.log(`[bundle] ${join(src, entry)} → ${join(dest, entry)}`)
    }
  }
}
