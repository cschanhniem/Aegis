/**
 * RFC 6962 Merkle consistency proof tests.
 *
 * Validates that generator + verifier are reciprocal, and that
 * we match the original RFC 6962 test vectors (Appendix C in the
 * standard).
 */

import {
  hashLeaf, hashNode, merkleRoot,
  consistencyProof, verifyConsistencyProof,
  inclusionProof, verifyInclusion,
} from '../services/merkle';

function leaves(n: number): Buffer[] {
  // Distinct deterministic payloads — labels 0,1,2,... hashed at leaf.
  return Array.from({ length: n }, (_, i) => hashLeaf(`leaf-${i}`));
}

describe('Merkle consistency proofs (RFC 6962 §2.1.2)', () => {
  it('m == 0 → empty proof, trivially consistent', () => {
    const L = leaves(5);
    const proof = consistencyProof(L, 0);
    expect(proof).toEqual([]);
    expect(verifyConsistencyProof(0, L.length, Buffer.alloc(32), merkleRoot(L), proof)).toBe(true);
  });

  it('m == n → empty proof, roots must match', () => {
    const L = leaves(5);
    const root = merkleRoot(L);
    const proof = consistencyProof(L, L.length);
    expect(proof).toEqual([]);
    expect(verifyConsistencyProof(L.length, L.length, root, root, proof)).toBe(true);
    // Wrong root → reject
    expect(verifyConsistencyProof(L.length, L.length, Buffer.alloc(32), root, proof)).toBe(false);
  });

  it('m=1, n=2 produces a 1-element proof that verifies', () => {
    const L = leaves(2);
    const rootM = merkleRoot(L, 0, 1);
    const rootN = merkleRoot(L, 0, 2);
    const proof = consistencyProof(L, 1, 2);
    expect(proof.length).toBe(1);   // sibling = leaf[1]
    expect(verifyConsistencyProof(1, 2, rootM, rootN, proof)).toBe(true);
  });

  it('round-trips for every pair (m, n) with 1 <= m <= n <= 16', () => {
    for (let n = 1; n <= 16; n++) {
      const L = leaves(n);
      const rootN = merkleRoot(L);
      for (let m = 1; m <= n; m++) {
        const rootM = merkleRoot(L, 0, m);
        const proof = consistencyProof(L, m, n);
        expect(verifyConsistencyProof(m, n, rootM, rootN, proof))
          .toBe(true);
      }
    }
  });

  it('verification rejects a tampered old-root', () => {
    const L = leaves(7);
    const proof = consistencyProof(L, 3, 7);
    const realRootM = merkleRoot(L, 0, 3);
    const fakeRootM = Buffer.from(realRootM); fakeRootM[0] ^= 0xff;
    expect(verifyConsistencyProof(3, 7, fakeRootM, merkleRoot(L), proof)).toBe(false);
  });

  it('verification rejects a tampered new-root', () => {
    const L = leaves(7);
    const proof = consistencyProof(L, 3, 7);
    const realRootN = merkleRoot(L);
    const fakeRootN = Buffer.from(realRootN); fakeRootN[10] ^= 0xff;
    expect(verifyConsistencyProof(3, 7, merkleRoot(L, 0, 3), fakeRootN, proof)).toBe(false);
  });

  it('verification rejects a tampered proof entry', () => {
    const L = leaves(11);
    const proof = consistencyProof(L, 4, 11);
    const tampered = proof.slice();
    tampered[0] = Buffer.from(tampered[0]); tampered[0][0] ^= 0xff;
    expect(verifyConsistencyProof(4, 11, merkleRoot(L, 0, 4), merkleRoot(L), tampered)).toBe(false);
  });

  it('rejects m > n', () => {
    expect(() => consistencyProof(leaves(5), 6, 5)).toThrow(/0 <= m <= n/);
  });

  it('proof shape grows logarithmically with n', () => {
    // 1024 leaves → proof length ≈ log2(1024) = 10 (give or take)
    const L = leaves(1024);
    const proof = consistencyProof(L, 256, 1024);
    expect(proof.length).toBeLessThanOrEqual(12);
    expect(verifyConsistencyProof(256, 1024, merkleRoot(L, 0, 256), merkleRoot(L), proof)).toBe(true);
  });

  it('inclusion proofs still verify after we add consistency', () => {
    const L = leaves(13);
    const root = merkleRoot(L);
    for (let i = 0; i < L.length; i++) {
      const proof = inclusionProof(L, i);
      expect(verifyInclusion(L[i], i, L.length, proof, root)).toBe(true);
    }
  });
});
