#!/usr/bin/env node
/**
 * Tiny migration runner — applies SQL files in migrations/ in lexical
 * order to DATABASE_URL, tracking applied versions in a
 * `_control_plane_migrations` table.
 *
 * Reads .env.local then .env from the parent directory so dev can just
 * `npm run migrate` without exporting vars.
 *
 * Usage: node scripts/migrate.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(here, '..', 'migrations')

/** Tiny .env loader — just KEY=VALUE per line, # comments, no quoting. */
async function loadEnv(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!(k in process.env)) process.env[k] = v
    }
  } catch { /* file missing is fine */ }
}
await loadEnv(path.join(here, '..', '.env.local'))
await loadEnv(path.join(here, '..', '.env'))

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required (set in .env.local or env)')
  process.exit(1)
}

const { default: postgres } = await import('postgres')
const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  await sql`
    CREATE TABLE IF NOT EXISTS _control_plane_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  const applied = new Set(
    (await sql`SELECT version FROM _control_plane_migrations`).map(r => r.version),
  )

  const files = (await fs.readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const f of files) {
    if (applied.has(f)) {
      console.log(`✓ ${f} already applied`)
      continue
    }
    const sqlText = await fs.readFile(path.join(migrationsDir, f), 'utf8')
    console.log(`→ applying ${f} ...`)
    await sql.begin(async tx => {
      await tx.unsafe(sqlText)
      await tx`INSERT INTO _control_plane_migrations (version) VALUES (${f})`
    })
    console.log(`✓ ${f} applied`)
  }

  console.log('All migrations up to date.')
} finally {
  await sql.end()
}
