/**
 * GroupStore — SCIM Groups + their members.
 *
 * Two tables under one store because membership is meaningless without
 * the group it belongs to and the queries always join them.
 *
 *   groups        per-org group definitions (display_name, external_id)
 *   group_members many-to-many user ↔ group join table
 *
 * RFC 7644 §4.2 groups can be deleted at any time, which CASCADEs to
 * the join table. The Sqlite adapter relies on the foreign key
 * constraint; the Postgres adapter uses ON DELETE CASCADE.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface GroupRow {
  id: string;
  org_id: string;
  display_name: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMemberRef {
  value: string;     // user id
  display?: string;  // user display name (joined)
}

export interface GroupStore {
  init(): Promise<void>;
  insert(opts: { id: string; orgId: string; displayName: string; externalId?: string | null }): Promise<void>;
  get(orgId: string, id: string): Promise<GroupRow | null>;
  list(opts: { orgId: string; limit?: number; offset?: number; whereExtra?: { where: string; params: any[] } }): Promise<{ entries: GroupRow[]; total: number }>;
  rename(orgId: string, id: string, newDisplayName: string): Promise<void>;
  delete(orgId: string, id: string): Promise<boolean>;

  // Membership
  setMembers(orgId: string, groupId: string, userIds: string[]): Promise<void>;
  addMembers(orgId: string, groupId: string, userIds: string[]): Promise<void>;
  removeMembers(orgId: string, groupId: string, userIds: string[]): Promise<void>;
  listMembers(groupId: string): Promise<GroupMemberRef[]>;
  listGroupsForUser(userId: string): Promise<GroupMemberRef[]>;

  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteGroupStore implements GroupStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        external_id TEXT,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, display_name)
      );
      CREATE INDEX IF NOT EXISTS idx_groups_org ON groups(org_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_scim_extid
        ON groups(org_id, external_id) WHERE external_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
    `);
  }

  async insert(opts: { id: string; orgId: string; displayName: string; externalId?: string | null }): Promise<void> {
    this.db.prepare(
      `INSERT INTO groups (id, org_id, external_id, display_name) VALUES (?, ?, ?, ?)`,
    ).run(opts.id, opts.orgId, opts.externalId ?? null, opts.displayName);
  }

  async get(orgId: string, id: string): Promise<GroupRow | null> {
    return (this.db.prepare(`SELECT * FROM groups WHERE id = ? AND org_id = ?`).get(id, orgId) as any) ?? null;
  }

  async list(opts: { orgId: string; limit?: number; offset?: number; whereExtra?: { where: string; params: any[] } }): Promise<{ entries: GroupRow[]; total: number }> {
    let where = `org_id = ?`;
    const params: any[] = [opts.orgId];
    if (opts.whereExtra) { where += ` AND ${opts.whereExtra.where}`; params.push(...opts.whereExtra.params); }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM groups WHERE ${where}`).get(...params) as any).n;
    const limit = Math.min(opts.limit ?? 100, 200);
    const offset = opts.offset ?? 0;
    const entries = this.db.prepare(
      `SELECT * FROM groups WHERE ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as GroupRow[];
    return { entries, total };
  }

  async rename(orgId: string, id: string, newDisplayName: string): Promise<void> {
    this.db.prepare(
      `UPDATE groups SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND org_id = ?`,
    ).run(newDisplayName, id, orgId);
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM groups WHERE id = ? AND org_id = ?`).run(id, orgId);
    // Sqlite without ON DELETE CASCADE — clear member rows explicitly.
    this.db.prepare(`DELETE FROM group_members WHERE group_id = ?`).run(id);
    return r.changes > 0;
  }

  async setMembers(_orgId: string, groupId: string, userIds: string[]): Promise<void> {
    this.db.prepare(`DELETE FROM group_members WHERE group_id = ?`).run(groupId);
    await this.addMembers(_orgId, groupId, userIds);
  }

  async addMembers(_orgId: string, groupId: string, userIds: string[]): Promise<void> {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`);
    for (const uid of userIds) stmt.run(groupId, uid);
  }

  async removeMembers(_orgId: string, groupId: string, userIds: string[]): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`);
    for (const uid of userIds) stmt.run(groupId, uid);
  }

  async listMembers(groupId: string): Promise<GroupMemberRef[]> {
    return this.db.prepare(
      `SELECT u.id AS value, u.name AS display FROM group_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`,
    ).all(groupId) as any;
  }

  async listGroupsForUser(userId: string): Promise<GroupMemberRef[]> {
    return this.db.prepare(
      `SELECT g.id AS value, g.display_name AS display FROM group_members gm
       JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?`,
    ).all(userId) as any;
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    external_id TEXT,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, display_name)
  );
  CREATE INDEX IF NOT EXISTS idx_groups_org ON groups(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_scim_extid
    ON groups(org_id, external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
`;

export class PostgresGroupStore implements GroupStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async insert(opts: { id: string; orgId: string; displayName: string; externalId?: string | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO groups (id, org_id, external_id, display_name) VALUES ($1, $2, $3, $4)`,
      [opts.id, opts.orgId, opts.externalId ?? null, opts.displayName],
    );
  }

  async get(orgId: string, id: string): Promise<GroupRow | null> {
    const r = await this.pool.query(`SELECT * FROM groups WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (r.rows[0] as any) ?? null;
  }

  async list(opts: { orgId: string; limit?: number; offset?: number; whereExtra?: { where: string; params: any[] } }): Promise<{ entries: GroupRow[]; total: number }> {
    let where = `org_id = $1`;
    const params: any[] = [opts.orgId];
    if (opts.whereExtra) {
      let i = 0;
      const renumbered = opts.whereExtra.where.replace(/\?/g, () => `$${params.length + (++i)}`);
      where += ` AND ${renumbered}`;
      params.push(...opts.whereExtra.params);
    }
    const totalRes = await this.pool.query(`SELECT COUNT(*)::int AS n FROM groups WHERE ${where}`, params);
    const total = (totalRes.rows[0] as any).n;
    const limit = Math.min(opts.limit ?? 100, 200);
    const offset = opts.offset ?? 0;
    const r = await this.pool.query(
      `SELECT * FROM groups WHERE ${where} ORDER BY created_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: r.rows as GroupRow[], total };
  }

  async rename(orgId: string, id: string, newDisplayName: string): Promise<void> {
    await this.pool.query(
      `UPDATE groups SET display_name = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
      [newDisplayName, id, orgId],
    );
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM groups WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (r.rowCount ?? 0) > 0;
  }

  async setMembers(_orgId: string, groupId: string, userIds: string[]): Promise<void> {
    await this.pool.query(`DELETE FROM group_members WHERE group_id = $1`, [groupId]);
    await this.addMembers(_orgId, groupId, userIds);
  }

  async addMembers(_orgId: string, groupId: string, userIds: string[]): Promise<void> {
    for (const uid of userIds) {
      await this.pool.query(
        `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [groupId, uid],
      );
    }
  }

  async removeMembers(_orgId: string, groupId: string, userIds: string[]): Promise<void> {
    for (const uid of userIds) {
      await this.pool.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, uid]);
    }
  }

  async listMembers(groupId: string): Promise<GroupMemberRef[]> {
    const r = await this.pool.query(
      `SELECT u.id AS value, u.name AS display FROM group_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
      [groupId],
    );
    return r.rows as any;
  }

  async listGroupsForUser(userId: string): Promise<GroupMemberRef[]> {
    const r = await this.pool.query(
      `SELECT g.id AS value, g.display_name AS display FROM group_members gm
       JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1`,
      [userId],
    );
    return r.rows as any;
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
