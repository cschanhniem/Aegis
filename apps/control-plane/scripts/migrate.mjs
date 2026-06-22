#!/usr/bin/env node
/**
 * Tiny migration runner — applies SQL files in migrations/ in lexical
 * order to DATABASE_URL, tracking applied versions in a
 * `_control_plane_migrations` table.
 *
 * Usage: node scripts/migrate.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(here, '..', 'migrations')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
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
