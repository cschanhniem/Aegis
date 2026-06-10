/**
 * WitnessStore — RFC 6962-style transparency-log witness records.
 *
 * Two tables under one store because they're always queried together:
 *
 *   transparency_witness            registered IdP-style "witnesses" who
 *                                   sign the Merkle tree root
 *   transparency_witness_cosignature one row per (witness × root_hash);
 *                                   the actual co-signature material
 *
 * Per-org tenant isolation on the witness registration; cosignatures
 * inherit org scope through the witness_id foreign key.
 */

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';

export interface WitnessRow {
  id: string;
  org_id: string;
  name: string;
  public_key_pem: string;
  registered_at: string;
  active: number;
}

export interface WitnessCosignatureRow {
  id: number;
  witness_id: string;
  tree_size: number;
  root_hash: string;
  signature: string;
  cosigned_at: string;
}

export interface WitnessStore {
  init(): Promise<void>;
  registerWitness(opts: { id: string; orgId: string; name: string; publicKeyPem: string }): Promise<void>;
  listWitnesses(orgId: string, opts?: { active_only?: boolean }): Promise<WitnessRow[]>;
  getWitness(id: string): Promise<WitnessRow | null>;
  deactivateWitness(orgId: string, id: string): Promise<boolean>;

  insertCosignature(row: { witness_id: string; tree_size: number; root_hash: string; signature: string }): Promise<void>;
  /** All cosignatures for a given root_hash (for the org-scoped consumer
   *  view). We DON'T filter by org here — the witness_id FK is enough,
   *  and consumers join with `transparency_witness.org_id` if needed. */
  findCosignaturesForRoot(rootHash: string): Promise<WitnessCosignatureRow[]>;
  close(): Promise<void>;
}

// ── Sqlite ───────────────────────────────────────────────────────────

export class SqliteWitnessStore implements WitnessStore {
  constructor(private db: Database.Database) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transparency_witness (
        id              TEXT PRIMARY KEY,
        org_id          TEXT NOT NULL,
        name            TEXT NOT NULL,
        public_key_pem  TEXT NOT NULL,
        registered_at   TEXT NOT NULL DEFAULT (datetime('now')),
        active          INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_witness_org ON transparency_witness(org_id, active);

      CREATE TABLE IF NOT EXISTS transparency_witness_cosignature (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        witness_id   TEXT NOT NULL,
        tree_size    INTEGER NOT NULL,
        root_hash    TEXT NOT NULL,
        signature    TEXT NOT NULL,
        cosigned_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cosign_root    ON transparency_witness_cosignature(root_hash);
      CREATE INDEX IF NOT EXISTS idx_cosign_witness ON transparency_witness_cosignature(witness_id, tree_size DESC);
    `);
  }

  async registerWitness(o: { id: string; orgId: string; name: string; publicKeyPem: string }): Promise<void> {
    this.db.prepare(
      `INSERT INTO transparency_witness (id, org_id, name, public_key_pem) VALUES (?, ?, ?, ?)`,
    ).run(o.id, o.orgId, o.name, o.publicKeyPem);
  }

  async listWitnesses(orgId: string, opts: { active_only?: boolean } = {}): Promise<WitnessRow[]> {
    const where = opts.active_only ? `org_id = ? AND active = 1` : `org_id = ?`;
    return this.db.prepare(
      `SELECT * FROM transparency_witness WHERE ${where} ORDER BY registered_at ASC`,
    ).all(orgId) as WitnessRow[];
  }

  async getWitness(id: string): Promise<WitnessRow | null> {
    return (this.db.prepare(`SELECT * FROM transparency_witness WHERE id = ?`).get(id) as any) ?? null;
  }

  async deactivateWitness(orgId: string, id: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE transparency_witness SET active = 0 WHERE id = ? AND org_id = ? AND active = 1`,
    ).run(id, orgId);
    return r.changes > 0;
  }

  async insertCosignature(row: { witness_id: string; tree_size: number; root_hash: string; signature: string }): Promise<void> {
    this.db.prepare(
      `INSERT INTO transparency_witness_cosignature (witness_id, tree_size, root_hash, signature) VALUES (?, ?, ?, ?)`,
    ).run(row.witness_id, row.tree_size, row.root_hash, row.signature);
  }

  async findCosignaturesForRoot(rootHash: string): Promise<WitnessCosignatureRow[]> {
    return this.db.prepare(
      `SELECT * FROM transparency_witness_cosignature WHERE root_hash = ? ORDER BY cosigned_at ASC`,
    ).all(rootHash) as WitnessCosignatureRow[];
  }

  async close(): Promise<void> {}
}

// ── Postgres ─────────────────────────────────────────────────────────

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS transparency_witness (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL,
    name            TEXT NOT NULL,
    public_key_pem  TEXT NOT NULL,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active          INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_witness_org ON transparency_witness(org_id, active);

  CREATE TABLE IF NOT EXISTS transparency_witness_cosignature (
    id           BIGSERIAL PRIMARY KEY,
    witness_id   TEXT NOT NULL,
    tree_size    INTEGER NOT NULL,
    root_hash    TEXT NOT NULL,
    signature    TEXT NOT NULL,
    cosigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_cosign_root    ON transparency_witness_cosignature(root_hash);
  CREATE INDEX IF NOT EXISTS idx_cosign_witness ON transparency_witness_cosignature(witness_id, tree_size DESC);
`;

export class PostgresWitnessStore implements WitnessStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> { await this.pool.query(PG_SCHEMA); }

  async registerWitness(o: { id: string; orgId: string; name: string; publicKeyPem: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO transparency_witness (id, org_id, name, public_key_pem) VALUES ($1, $2, $3, $4)`,
      [o.id, o.orgId, o.name, o.publicKeyPem],
    );
  }

  async listWitnesses(orgId: string, opts: { active_only?: boolean } = {}): Promise<WitnessRow[]> {
    const where = opts.active_only ? `org_id = $1 AND active = 1` : `org_id = $1`;
    const r = await this.pool.query(
      `SELECT * FROM transparency_witness WHERE ${where} ORDER BY registered_at ASC`,
      [orgId],
    );
    return r.rows as WitnessRow[];
  }

  async getWitness(id: string): Promise<WitnessRow | null> {
    const r = await this.pool.query(`SELECT * FROM transparency_witness WHERE id = $1`, [id]);
    return (r.rows[0] as any) ?? null;
  }

  async deactivateWitness(orgId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE transparency_witness SET active = 0 WHERE id = $1 AND org_id = $2 AND active = 1`,
      [id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async insertCosignature(row: { witness_id: string; tree_size: number; root_hash: string; signature: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO transparency_witness_cosignature (witness_id, tree_size, root_hash, signature) VALUES ($1, $2, $3, $4)`,
      [row.witness_id, row.tree_size, row.root_hash, row.signature],
    );
  }

  async findCosignaturesForRoot(rootHash: string): Promise<WitnessCosignatureRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM transparency_witness_cosignature WHERE root_hash = $1 ORDER BY cosigned_at ASC`,
      [rootHash],
    );
    return r.rows as WitnessCosignatureRow[];
  }

  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
