/**
 * Transparency Log Service — append-only, Ed25519-signed Merkle log over
 * AEGIS audit and evidence-pack events.
 *
 * Customers can:
 *   1. Pull a signed root         → GET /api/v1/transparency-log/root
 *   2. Pull any leaf payload       → GET /api/v1/transparency-log/entry/:idx
 *   3. Pull an inclusion proof     → GET /api/v1/transparency-log/proof/:idx
 *   4. Verify (1)+(2)+(3) offline  → recompute root from leaf + proof, check signature
 *
 * The signature binds (tree_size, root_hash, timestamp) so a customer
 * archiving signed roots can detect if AEGIS later tries to present a
 * different log for the same tree size (split-view attack).
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { hashLeaf, merkleRoot, inclusionProof } from './merkle';
import { SigningService, SignaturePayload } from './signing';

export interface TransparencyEntry {
  index: number;
  leaf_hash: string;     // hex
  payload: string;       // canonical JSON
  source: string;
  org_id?: string;
  created_at: string;
}

export interface SignedRoot {
  tree_size: number;
  root_hash: string;     // hex
  timestamp: string;     // ISO8601
  signature: SignaturePayload;
}

export interface InclusionProofResponse {
  index: number;
  tree_size: number;
  leaf_hash: string;             // hex
  proof: string[];               // hex sibling hashes, leaf-up
  signed_root: SignedRoot;
}

function canonicalJson(obj: unknown): string {
  // Deterministic key ordering for stable hashes. Same shape used in
  // evidence-pack.ts.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

export class TransparencyLogService {
  private insertStmt: Database.Statement;
  private selectAllHashesStmt: Database.Statement;
  private selectEntryStmt: Database.Statement;
  private countStmt: Database.Statement;

  constructor(
    private db: Database.Database,
    private signer: SigningService,
    private logger: Logger,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO transparency_log (leaf_hash, payload, source, org_id) VALUES (?, ?, ?, ?)`,
    );
    this.selectAllHashesStmt = db.prepare(
      `SELECT id, leaf_hash FROM transparency_log ORDER BY id ASC`,
    );
    this.selectEntryStmt = db.prepare(
      `SELECT id, leaf_hash, payload, source, org_id, created_at FROM transparency_log WHERE id = ?`,
    );
    this.countStmt = db.prepare(`SELECT COUNT(*) AS n FROM transparency_log`);
  }

  /**
   * Append a payload as a new leaf. Returns the leaf's 1-indexed log id
   * (matches `id` column) and its hex leaf hash.
   */
  append(opts: { payload: unknown; source: string; org_id?: string }): { index: number; leaf_hash: string } {
    const canonical = canonicalJson(opts.payload);
    const leaf = hashLeaf(Buffer.from(canonical, 'utf8'));
    const leafHex = leaf.toString('hex');
    const result = this.insertStmt.run(leafHex, canonical, opts.source, opts.org_id ?? null);
    const index = Number(result.lastInsertRowid);
    return { index, leaf_hash: leafHex };
  }

  size(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /**
   * Build the leaf array for tree of given size. Currently O(n) per call —
   * fine at v1 volumes (admin_audit_log is at most thousands per day). A
   * v1.1 optimization can cache subtree roots; the public API doesn't
   * change because the verifier is pure functions over leaves.
   */
  private loadLeavesUpTo(treeSize: number): Buffer[] {
    if (treeSize <= 0) return [];
    const rows = this.selectAllHashesStmt.all() as Array<{ id: number; leaf_hash: string }>;
    return rows.slice(0, treeSize).map(r => Buffer.from(r.leaf_hash, 'hex'));
  }

  /**
   * Signed root for tree of size N (default = current size). Signature is
   * over canonical JSON of { tree_size, root_hash, timestamp } using the
   * gateway's Ed25519 evidence key.
   */
  signedRoot(treeSize?: number): SignedRoot | null {
    const n = treeSize ?? this.size();
    if (n === 0) return null;
    const leaves = this.loadLeavesUpTo(n);
    const root = merkleRoot(leaves);
    const rootHex = root.toString('hex');
    const timestamp = new Date().toISOString();
    const signature = this.signer.sign(
      canonicalJson({ tree_size: n, root_hash: rootHex, timestamp }),
    );
    return { tree_size: n, root_hash: rootHex, timestamp, signature };
  }

  getEntry(index: number): TransparencyEntry | null {
    const row = this.selectEntryStmt.get(index) as
      | { id: number; leaf_hash: string; payload: string; source: string; org_id: string | null; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      index: row.id,
      leaf_hash: row.leaf_hash,
      payload: row.payload,
      source: row.source,
      org_id: row.org_id ?? undefined,
      created_at: row.created_at,
    };
  }

  /**
   * Inclusion proof for the leaf at 1-indexed log id `index` within a tree
   * of size `treeSize` (default = current size). Bundled with the signed
   * root so the customer can verify in a single API call.
   */
  getProof(index: number, treeSize?: number): InclusionProofResponse | null {
    const n = treeSize ?? this.size();
    if (n === 0 || index < 1 || index > n) return null;
    const entry = this.getEntry(index);
    if (!entry) return null;
    const leaves = this.loadLeavesUpTo(n);
    // RFC 6962 indexes leaves 0..n-1. Our DB id is 1-indexed.
    const m = index - 1;
    const proof = inclusionProof(leaves, m, n);
    const signed = this.signedRoot(n);
    if (!signed) return null;
    return {
      index,
      tree_size: n,
      leaf_hash: entry.leaf_hash,
      proof: proof.map(b => b.toString('hex')),
      signed_root: signed,
    };
  }
}
