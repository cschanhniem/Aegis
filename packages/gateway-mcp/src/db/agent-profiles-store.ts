/**
 * AgentProfilesStore — ML / behaviour-baseline state per agent.
 *
 * One row per agent_id. The row is rewritten in place (UPSERT) every
 * time the baseline learner ticks. Reads are hot (every check pulls
 * the baseline to compare current trace against). The total table
 * stays small (1 row per active agent) so no batching is needed.
 *
 * Tenant isolation note: agent_id is globally unique by construction
 * (agents register through AgentRegistryService which enforces
 * org-scoped uniqueness on registration). We don't carry org_id here
 * because every agent_id already maps 1:1 to one tenant via the
 * registry.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface AgentProfileRow {
  agent_id: string;
  profile_json: string;
  trace_count: number;
  updated_at: string;
}

export interface AgentProfilesStore {
  init(): Promise<void>;
  upsert(agentId: string, profileJson: string, traceCount: number): Promise<void>;
  get(agentId: string): Promise<AgentProfileRow | null>;
  list(): Promise<AgentProfileRow[]>;
  delete(agentId: string): Promise<boolean>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteAgentProfilesStore implements AgentProfilesStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        agent_id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        trace_count INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  async upsert(agentId: string, profileJson: string, traceCount: number): Promise<void> {
    this.db.prepare(
      `INSERT INTO agent_profiles (agent_id, profile_json, trace_count, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(agent_id) DO UPDATE SET
         profile_json = excluded.profile_json,
         trace_count = excluded.trace_count,
         updated_at = datetime('now')`,
    ).run(agentId, profileJson, traceCount);
  }

  async get(agentId: string): Promise<AgentProfileRow | null> {
    return (this.db.prepare(`SELECT * FROM agent_profiles WHERE agent_id = ?`).get(agentId) as any) ?? null;
  }

  async list(): Promise<AgentProfileRow[]> {
    return this.db.prepare(`SELECT * FROM agent_profiles ORDER BY updated_at DESC`).all() as AgentProfileRow[];
  }

  async delete(agentId: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM agent_profiles WHERE agent_id = ?`).run(agentId);
    return r.changes > 0;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_profiles (
    agent_id TEXT PRIMARY KEY,
    profile_json TEXT NOT NULL,
    trace_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export class PostgresAgentProfilesStore implements AgentProfilesStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async upsert(agentId: string, profileJson: string, traceCount: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_profiles (agent_id, profile_json, trace_count, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT(agent_id) DO UPDATE SET
         profile_json = EXCLUDED.profile_json,
         trace_count = EXCLUDED.trace_count,
         updated_at = NOW()`,
      [agentId, profileJson, traceCount],
    );
  }

  async get(agentId: string): Promise<AgentProfileRow | null> {
    const r = await this.pool.query(`SELECT * FROM agent_profiles WHERE agent_id = $1`, [agentId]);
    return (r.rows[0] as any) ?? null;
  }

  async list(): Promise<AgentProfileRow[]> {
    const r = await this.pool.query(`SELECT * FROM agent_profiles ORDER BY updated_at DESC`);
    return r.rows as AgentProfileRow[];
  }

  async delete(agentId: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM agent_profiles WHERE agent_id = $1`, [agentId]);
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
