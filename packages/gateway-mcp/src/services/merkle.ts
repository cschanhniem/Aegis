/**
 * RFC 6962 Merkle hash tree — Certificate-Transparency convention.
 *
 *   leaf_hash    = SHA-256(0x00 || payload)
 *   node_hash    = SHA-256(0x01 || left_hash || right_hash)
 *   tree_root(n) for n leaves: split [0..k) and [k..n) where k is the
 *                largest power of 2 strictly less than n; root = node_hash
 *                of the two subtree roots. tree_root([leaf]) = leaf_hash.
 *
 * This file is pure data-in-data-out — no DB, no IO. The service that owns
 * the leaf list calls into it.
 */

import { createHash } from 'crypto';

export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;

export function hashLeaf(payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return createHash('sha256').update(Buffer.from([LEAF_PREFIX])).update(buf).digest();
}

export function hashNode(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.from([NODE_PREFIX])).update(left).update(right).digest();
}

/** Largest power of 2 strictly less than n. (n >= 2) */
function largestPow2Below(n: number): number {
  if (n < 2) throw new Error('largestPow2Below requires n >= 2');
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle root of leaves[start..end). Empty range → SHA-256 of empty string
 * (RFC 6962 §2.1).
 */
export function merkleRoot(leaves: ReadonlyArray<Buffer>, start = 0, end = leaves.length): Buffer {
  const n = end - start;
  if (n === 0) return createHash('sha256').digest();
  if (n === 1) return leaves[start];
  const k = largestPow2Below(n);
  const left = merkleRoot(leaves, start, start + k);
  const right = merkleRoot(leaves, start + k, end);
  return hashNode(left, right);
}

/**
 * Inclusion proof for leaf at index `m` within a tree of size `n` (RFC 6962 §2.1.1).
 * Returns the audit path: sibling hashes from leaf upward toward the root.
 * Verifier reconstructs the root by combining leaf_hash with each path entry.
 */
export function inclusionProof(
  leaves: ReadonlyArray<Buffer>,
  m: number,
  n: number = leaves.length,
): Buffer[] {
  if (m < 0 || m >= n) throw new Error(`leaf index ${m} out of range [0, ${n})`);
  return path(m, 0, n, leaves);
}

function path(m: number, start: number, end: number, leaves: ReadonlyArray<Buffer>): Buffer[] {
  const n = end - start;
  if (n === 1) return [];
  const k = largestPow2Below(n);
  const relM = m - start;
  if (relM < k) {
    // Left subtree contains the leaf. Sibling = right subtree root.
    return [...path(m, start, start + k, leaves), merkleRoot(leaves, start + k, end)];
  }
  // Right subtree contains the leaf. Sibling = left subtree root.
  return [...path(m, start + k, end, leaves), merkleRoot(leaves, start, start + k)];
}

/**
 * Verify an inclusion proof — recompute the root and compare. Pure function;
 * callers can run this without any AEGIS dependency to attest offline.
 *
 * The proof array is ordered leaf-deepest first, root-level last (matching
 * RFC 6962 §2.1.1). Verification recurses with the same shape as the
 * generator: at each level the LAST unread proof entry is the sibling of
 * the subtree containing the leaf.
 */
export function verifyInclusion(
  leafHash: Buffer,
  leafIndex: number,
  treeSize: number,
  proof: ReadonlyArray<Buffer>,
  expectedRoot: Buffer,
): boolean {
  if (leafIndex < 0 || leafIndex >= treeSize) return false;
  try {
    const recomputed = recompute(leafHash, leafIndex, treeSize, proof, proof.length);
    return recomputed.equals(expectedRoot);
  } catch {
    return false;
  }
}

function recompute(
  leafHash: Buffer,
  m: number,
  n: number,
  proof: ReadonlyArray<Buffer>,
  depth: number,
): Buffer {
  if (depth === 0) {
    if (n !== 1) throw new Error('proof exhausted before reaching single-leaf subtree');
    return leafHash;
  }
  if (n < 2) throw new Error('proof has entries remaining but subtree size < 2');
  const k = largestPow2Below(n);
  const sibling = proof[depth - 1];   // top-level sibling is the LAST entry
  if (m < k) {
    return hashNode(recompute(leafHash, m, k, proof, depth - 1), sibling);
  }
  return hashNode(sibling, recompute(leafHash, m - k, n - k, proof, depth - 1));
}
