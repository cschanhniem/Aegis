/**
 * Witness service — RFC 6962-style co-signing of transparency-log roots.
 *
 * Threat model this closes: AEGIS could present root R1 to Alice and a
 * different root R2 for the same tree size to Bob (a "split view"
 * attack). Inclusion + consistency proofs don't detect this on their
 * own — both Alice and Bob get internally-consistent stories.
 *
 * Solution (the Sigstore Rekor / CT log industry standard): external
 * **witnesses** publish their own Ed25519 keys and periodically pull
 * AEGIS's signed tree head (STH) and counter-sign it. Consumers fetch
 * the STH AND its witness cosignatures and only trust an STH when a
 * quorum of independent witnesses agreed. AEGIS cannot produce two
 * STHs for the same tree size that both pass quorum.
 *
 * Service responsibilities:
 *
 *   register(orgId, name, public_key_pem)
 *     Operator-only: register an external party's Ed25519 public key.
 *     The witness's public key is stored alongside its name.
 *
 *   currentSth()
 *     The STH to be signed. Returned over /witness/sth-to-sign for the
 *     witness's offline-signing loop.
 *
 *   cosign(witness_id, signature_b64u, sth_payload)
 *     A witness POSTs its signature here. We verify the signature
 *     against the registered public key + the canonical STH payload
 *     and persist (witness_id, tree_size, root_hash, signature).
 *
 *   signaturesFor(root_hash)
 *     Return all witness cosignatures for a given root.
 *
 * Quorum verification is consumer-side: AEGIS doesn't enforce N-of-M
 * itself (the consumer decides which witnesses they trust and how
 * many they need).
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { createHash, randomUUID, verify as cryptoVerify, createPublicKey } from 'crypto';
import { SigningService } from './signing';
import { TransparencyLogService, SignedRoot } from './transparency-log';

export interface RegisteredWitness {
  id: string;
  org_id: string;
  name: string;
  public_key_pem: string;
  registered_at: string;
  active: boolean;
}

export interface CosignatureRow {
  id: number;
  witness_id: string;
  witness_name: string;
  tree_size: number;
  root_hash: string;
  /** Base64url of the witness's signature over canonical STH. */
  signature: string;
  cosigned_at: string;
}

export interface WitnessCosignResult {
  ok: boolean;
  reason?: string;
  cosignature_id?: number;
}

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

function b64uToBuffer(s: string): Buffer {
  // Accept both base64url and standard base64; normalise to standard then decode.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  return Buffer.from(pad ? padded + '='.repeat(4 - pad) : padded, 'base64');
}

export class WitnessService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
    private tlog: TransparencyLogService,
    private signer: SigningService,
  ) {
    this.ensureTables();
  }

  private ensureTables(): void {
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
      CREATE INDEX IF NOT EXISTS idx_cosign_root ON transparency_witness_cosignature(root_hash);
      CREATE INDEX IF NOT EXISTS idx_cosign_witness ON transparency_witness_cosignature(witness_id, tree_size DESC);
    `);
  }

  /** Operator-only: register a new witness. The public key is stored
   *  verbatim PEM — verification happens at cosign time. */
  register(opts: { orgId: string; name: string; public_key_pem: string }): RegisteredWitness {
    // Validate PEM by attempting to parse — bad PEM throws here so
    // the operator gets a 400 instead of a runtime failure on first
    // cosign.
    try {
      createPublicKey({ key: opts.public_key_pem, format: 'pem', type: 'spki' });
    } catch (err: any) {
      throw new Error(`invalid public key PEM: ${err.message}`);
    }
    if (!opts.name || opts.name.length > 80) {
      throw new Error('witness name must be 1..80 chars');
    }
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO transparency_witness (id, org_id, name, public_key_pem) VALUES (?, ?, ?, ?)`,
    ).run(id, opts.orgId, opts.name, opts.public_key_pem);
    return this.get(opts.orgId, id)!;
  }

  /** Bulk-list registered witnesses (admin + consumer use the same view). */
  list(orgId: string): RegisteredWitness[] {
    const rows = this.db.prepare(
      `SELECT id, org_id, name, public_key_pem, registered_at, active
         FROM transparency_witness WHERE org_id = ? AND active = 1
         ORDER BY registered_at ASC`,
    ).all(orgId) as any[];
    return rows.map(r => ({ ...r, active: !!r.active }));
  }

  get(orgId: string, id: string): RegisteredWitness | null {
    const row = this.db.prepare(
      `SELECT id, org_id, name, public_key_pem, registered_at, active
         FROM transparency_witness WHERE org_id = ? AND id = ?`,
    ).get(orgId, id) as any;
    return row ? { ...row, active: !!row.active } : null;
  }

  deactivate(opts: { orgId: string; id: string }): boolean {
    const r = this.db.prepare(
      `UPDATE transparency_witness SET active = 0 WHERE id = ? AND org_id = ?`,
    ).run(opts.id, opts.orgId);
    return r.changes > 0;
  }

  /** The STH for witnesses to fetch and sign. Mirrors what AEGIS
   *  already returns from /transparency-log/root. Exposed here so the
   *  witness contract is co-located. */
  currentSth(): SignedRoot | null {
    return this.tlog.signedRoot();
  }

  /** Canonical bytes the witness must sign — same canonical-JSON shape
   *  AEGIS uses for its own signature. Returned so witnesses can verify
   *  EXACTLY what they're signing. */
  static canonicalSthBytes(sth: { tree_size: number; root_hash: string; timestamp: string }): string {
    return canonicalJson({ tree_size: sth.tree_size, root_hash: sth.root_hash, timestamp: sth.timestamp });
  }

  /**
   * A witness POSTs its signature here. Verifies the signature with
   * Ed25519 against the witness's registered PEM + the canonical STH.
   *
   * Cross-tenant isolation: a witness registered for org-A cannot
   * cosign on org-B's behalf.
   *
   * Dedup: re-submitting an identical signature for the same
   * (witness, root_hash) is a no-op (returns the existing id).
   */
  cosign(opts: {
    orgId: string;
    witness_id: string;
    tree_size: number;
    root_hash: string;
    timestamp: string;
    signature: string;        // base64url
  }): WitnessCosignResult {
    const witness = this.get(opts.orgId, opts.witness_id);
    if (!witness) return { ok: false, reason: 'witness not registered (or wrong tenant)' };
    if (!witness.active) return { ok: false, reason: 'witness deactivated' };

    const canonical = WitnessService.canonicalSthBytes({
      tree_size: opts.tree_size,
      root_hash: opts.root_hash,
      timestamp: opts.timestamp,
    });
    let sigBuf: Buffer;
    try { sigBuf = b64uToBuffer(opts.signature); }
    catch { return { ok: false, reason: 'malformed signature (expected base64url Ed25519)' }; }

    let pubKey;
    try { pubKey = createPublicKey({ key: witness.public_key_pem, format: 'pem', type: 'spki' }); }
    catch { return { ok: false, reason: 'witness public key is invalid' }; }

    // Ed25519: pass `null` for algorithm.
    const verified = cryptoVerify(null, Buffer.from(canonical, 'utf8'), pubKey, sigBuf);
    if (!verified) return { ok: false, reason: 'signature does not verify against registered key' };

    // Dedup
    const existing = this.db.prepare(
      `SELECT id FROM transparency_witness_cosignature
        WHERE witness_id = ? AND root_hash = ? AND signature = ? LIMIT 1`,
    ).get(opts.witness_id, opts.root_hash, opts.signature) as { id: number } | undefined;
    if (existing) return { ok: true, cosignature_id: existing.id };

    const r = this.db.prepare(
      `INSERT INTO transparency_witness_cosignature (witness_id, tree_size, root_hash, signature)
       VALUES (?, ?, ?, ?)`,
    ).run(opts.witness_id, opts.tree_size, opts.root_hash, opts.signature);
    return { ok: true, cosignature_id: Number(r.lastInsertRowid) };
  }

  /** Pull all cosignatures for a given root, scoped to a tenant
   *  (joins through transparency_witness on org_id). */
  signaturesFor(orgId: string, rootHash: string): CosignatureRow[] {
    const rows = this.db.prepare(
      `SELECT c.id, c.witness_id, w.name AS witness_name, c.tree_size, c.root_hash, c.signature, c.cosigned_at
         FROM transparency_witness_cosignature c
         JOIN transparency_witness w ON w.id = c.witness_id
        WHERE w.org_id = ? AND c.root_hash = ?
        ORDER BY c.cosigned_at ASC`,
    ).all(orgId, rootHash) as any[];
    return rows;
  }
}
