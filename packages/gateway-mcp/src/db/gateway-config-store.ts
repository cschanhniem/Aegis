/**
 * GatewayConfigStore — small typed key-value store for gateway-wide
 * configuration that isn't per-tenant (TenantConfigService handles
 * that). The bootstrap API key (`dashboard_api_key`) and other
 * operator-level toggles live here.
 *
 * Pattern parity with PolicyStore + AuditLogStore: one interface, two
 * adapters, env-driven factory. Tested via pg-mem; same contract
 * verified on both backends.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface GatewayConfigStore {
  init(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomic "fetch or insert" — used by the bootstrap API key path so
   *  a concurrent startup race never produces two keys. */
  getOrCreate(key: string, factory: () => string): Promise<string>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteGatewayConfigStore implements GatewayConfigStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async get(key: string): Promise<string | null> {
    const row = this.db.prepare(`SELECT value FROM gateway_config WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.db.prepare(
      `INSERT INTO gateway_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare(`DELETE FROM gateway_config WHERE key = ?`).run(key);
  }

  async getOrCreate(key: string, factory: () => string): Promise<string> {
    const existing = await this.get(key);
    if (existing !== null) return existing;
    const value = factory();
    // ON CONFLICT keeps the existing row if a sibling already inserted.
    this.db.prepare(
      `INSERT INTO gateway_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
    ).run(key, value);
    return (await this.get(key)) ?? value;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gateway_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export class PostgresGatewayConfigStore implements GatewayConfigStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(PG_SCHEMA);
  }

  async get(key: string): Promise<string | null> {
    const r = await this.pool.query(`SELECT value FROM gateway_config WHERE key = $1`, [key]);
    return r.rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO gateway_config (key, value) VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM gateway_config WHERE key = $1`, [key]);
  }

  async getOrCreate(key: string, factory: () => string): Promise<string> {
    const existing = await this.get(key);
    if (existing !== null) return existing;
    const value = factory();
    await this.pool.query(
      `INSERT INTO gateway_config (key, value) VALUES ($1, $2) ON CONFLICT(key) DO NOTHING`,
      [key, value],
    );
    return (await this.get(key)) ?? value;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
