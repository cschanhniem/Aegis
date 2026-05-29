import Database from 'better-sqlite3';
import pino from 'pino';
import { hashLeaf, merkleRoot, inclusionProof, verifyInclusion, hashNode } from '../services/merkle';
import { TransparencyLogService } from '../services/transparency-log';
import { SigningService } from '../services/signing';
import { createPublicKey, verify as edVerify } from 'crypto';

// ── Pure Merkle vectors (RFC 6962 §2.1.4 test vectors) ───────────────────

describe('RFC 6962 Merkle hash tree', () => {
  it('empty tree root = SHA-256("")', () => {
    expect(merkleRoot([]).toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('one-leaf tree root = leaf hash', () => {
    const leaf = hashLeaf(Buffer.from('hello'));
    expect(merkleRoot([leaf]).toString('hex')).toBe(leaf.toString('hex'));
  });

  it('two-leaf tree root = node_hash(left, right)', () => {
    const a = hashLeaf(Buffer.from('a'));
    const b = hashLeaf(Buffer.from('b'));
    expect(merkleRoot([a, b]).toString('hex')).toBe(hashNode(a, b).toString('hex'));
  });

  it('inclusion proof verifies for every leaf in a non-power-of-2 tree', () => {
    const leaves = [];
    for (let i = 0; i < 7; i++) leaves.push(hashLeaf(Buffer.from(`leaf-${i}`)));
    const root = merkleRoot(leaves);
    for (let m = 0; m < 7; m++) {
      const proof = inclusionProof(leaves, m, 7);
      expect(verifyInclusion(leaves[m], m, 7, proof, root)).toBe(true);
    }
  });

  it('verifyInclusion rejects mutated leaf', () => {
    const leaves = [hashLeaf(Buffer.from('a')), hashLeaf(Buffer.from('b')), hashLeaf(Buffer.from('c'))];
    const root = merkleRoot(leaves);
    const proof = inclusionProof(leaves, 1, 3);
    const tampered = hashLeaf(Buffer.from('not-b'));
    expect(verifyInclusion(tampered, 1, 3, proof, root)).toBe(false);
  });

  it('verifyInclusion rejects wrong tree size', () => {
    const leaves = [hashLeaf(Buffer.from('a')), hashLeaf(Buffer.from('b'))];
    const root = merkleRoot(leaves);
    const proof = inclusionProof(leaves, 0, 2);
    expect(verifyInclusion(leaves[0], 0, 3, proof, root)).toBe(false);
  });
});

// ── Service-level tests ────────────────────────────────────────────────

function makeService(): { svc: TransparencyLogService; db: Database.Database; signer: SigningService } {
  const db = new Database(':memory:');
  // Minimum schema TransparencyLogService needs.
  db.exec(`
    CREATE TABLE transparency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leaf_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      org_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE gateway_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const logger = pino({ level: 'silent' });
  const signer = new SigningService(db, logger);
  const svc = new TransparencyLogService(db, signer, logger);
  return { svc, db, signer };
}

describe('TransparencyLogService', () => {
  it('append → getEntry round-trips', () => {
    const { svc } = makeService();
    const { index, leaf_hash } = svc.append({
      payload: { action: 'policy.create', resource_id: 'p_42' },
      source: 'audit',
      org_id: 'default',
    });
    expect(index).toBe(1);
    const entry = svc.getEntry(index);
    expect(entry?.source).toBe('audit');
    expect(entry?.leaf_hash).toBe(leaf_hash);
    expect(JSON.parse(entry!.payload).resource_id).toBe('p_42');
  });

  it('signed root signature verifies with the returned public key', () => {
    const { svc } = makeService();
    svc.append({ payload: { a: 1 }, source: 'audit' });
    svc.append({ payload: { a: 2 }, source: 'audit' });
    const signed = svc.signedRoot()!;
    expect(signed.tree_size).toBe(2);

    // Reconstruct the canonical input the service signed. The service uses
    // alphabetically-sorted keys so root_hash < timestamp < tree_size.
    const canonical = `{"root_hash":${JSON.stringify(signed.root_hash)},"timestamp":${JSON.stringify(signed.timestamp)},"tree_size":${signed.tree_size}}`;
    const pub = createPublicKey(signed.signature.public_key_pem);
    const sigBuf = Buffer.from(signed.signature.signature, 'base64');
    const ok = edVerify(null, Buffer.from(canonical, 'utf8'), pub, sigBuf);
    expect(ok).toBe(true);
  });

  it('getProof returns an inclusion proof that verifies against the signed root', () => {
    const { svc } = makeService();
    for (let i = 0; i < 5; i++) svc.append({ payload: { i }, source: 'audit' });

    for (let idx = 1; idx <= 5; idx++) {
      const proof = svc.getProof(idx);
      expect(proof).not.toBeNull();
      const leafHash = Buffer.from(proof!.leaf_hash, 'hex');
      const root = Buffer.from(proof!.signed_root.root_hash, 'hex');
      const path = proof!.proof.map(h => Buffer.from(h, 'hex'));
      expect(verifyInclusion(leafHash, idx - 1, proof!.tree_size, path, root)).toBe(true);
    }
  });

  it('proof against a stale tree_size still verifies (historical roots)', () => {
    const { svc } = makeService();
    for (let i = 0; i < 3; i++) svc.append({ payload: { i }, source: 'audit' });
    const firstRoot = svc.signedRoot(3)!;
    svc.append({ payload: { i: 99 }, source: 'audit' });
    // Customer cached the size-3 root yesterday. Ask for a proof against
    // that size today — it should still verify.
    const proof = svc.getProof(2, 3)!;
    const leafHash = Buffer.from(proof.leaf_hash, 'hex');
    const root = Buffer.from(firstRoot.root_hash, 'hex');
    const path = proof.proof.map(h => Buffer.from(h, 'hex'));
    expect(verifyInclusion(leafHash, 1, 3, path, root)).toBe(true);
  });

  it('size() reflects current row count', () => {
    const { svc } = makeService();
    expect(svc.size()).toBe(0);
    svc.append({ payload: { a: 1 }, source: 'audit' });
    expect(svc.size()).toBe(1);
  });
});
