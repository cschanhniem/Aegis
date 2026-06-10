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

/**
 * Consistency proof between tree sizes `m` (older) and `n` (newer)
 * — RFC 6962 §2.1.2.
 *
 * Why this matters: without consistency proofs, AEGIS could silently
 * fork the log (present root_A to alice, root_B to bob). With them,
 * any consumer can hand both signed roots back to AEGIS and demand
 * "prove the size-m tree is a prefix of the size-n tree." If we can't
 * produce a valid proof, we got caught.
 *
 * Algorithm (RFC 6962 §2.1.2):
 *
 *   SUBPROOF(m, D[0:n], true)  =  []        if m == n
 *   SUBPROOF(m, D[0:n], false) = [MTH(D)]   if m == n
 *
 *   For m < n, let k = largest power of 2 < n:
 *     m <= k:   SUBPROOF(m, D[0:k], b)        ++ [MTH(D[k:n])]
 *     m  > k:   SUBPROOF(m-k, D[k:n], false)  ++ [MTH(D[0:k])]
 *
 * b ("complete") starts true; becomes false when we descend into a
 * subtree where the root of D[0:m] equals the subtree root and would
 * otherwise be implicit.
 */
export function consistencyProof(
  leaves: ReadonlyArray<Buffer>,
  m: number,
  n: number = leaves.length,
): Buffer[] {
  if (m < 0 || m > n) throw new Error(`consistency proof requires 0 <= m <= n; got m=${m}, n=${n}`);
  if (m === 0 || m === n) return [];
  return subproof(m, leaves, 0, n, true);
}

function subproof(
  m: number,
  leaves: ReadonlyArray<Buffer>,
  start: number,
  end: number,
  complete: boolean,
): Buffer[] {
  const n = end - start;
  if (m === n) {
    return complete ? [] : [merkleRoot(leaves, start, end)];
  }
  const k = largestPow2Below(n);
  if (m <= k) {
    return [...subproof(m, leaves, start, start + k, complete), merkleRoot(leaves, start + k, end)];
  }
  // m > k
  return [...subproof(m - k, leaves, start + k, end, false), merkleRoot(leaves, start, start + k)];
}

/**
 * Verify a consistency proof — RFC 6962 §2.1.4.
 *
 * Given the old signed root (root_m for tree size m) and the new
 * signed root (root_n for tree size n, n >= m) plus the consistency
 * proof, recompute and assert both roots.
 *
 * Pure function. Callers can audit AEGIS offline by archiving signed
 * roots over time and running this between any pair.
 */
export function verifyConsistencyProof(
  m: number,
  n: number,
  rootM: Buffer,
  rootN: Buffer,
  proof: ReadonlyArray<Buffer>,
): boolean {
  if (m < 0 || m > n) return false;
  if (m === 0)        return n === 0 ? rootM.equals(rootN) : true;   // trivial: empty prefix of anything
  if (m === n)        return rootM.equals(rootN) && proof.length === 0;

  // Algorithm follows RFC 6962 §2.1.4 verbatim.
  // Walk down to find the "split point" between m and n by repeatedly
  // peeling the largest power-of-2 subtree off the right.
  let proofArr = proof.slice();
  // If m is a power of 2 sub-tree at the start, root_m IS the first
  // implicit sibling — the proof omits it.
  let consumeRootM = false;
  if (isPow2(m)) {
    consumeRootM = true;
  } else {
    // First proof entry must be supplied explicitly.
    if (proofArr.length === 0) return false;
  }
  // We mirror the generator: walk down, the proof's last entries are
  // the upper levels. Easiest is to call a recursive helper.
  try {
    const [computedM, computedN] = recomputeConsistency(m, n, rootM, proofArr, consumeRootM);
    return computedM.equals(rootM) && computedN.equals(rootN);
  } catch { return false; }
}

function isPow2(x: number): boolean {
  return x > 0 && (x & (x - 1)) === 0;
}

function recomputeConsistency(
  m: number,
  n: number,
  rootM: Buffer,
  proof: ReadonlyArray<Buffer>,
  consumeRootM: boolean,
): [Buffer, Buffer] {
  // Decompose (m, n) into a sequence of (k, n - k) splits like the
  // generator did. We then rebuild both roots from the proof entries.
  //
  // Strategy: emulate generator structure, using proof entries as the
  // "right-subtree-root" of each split step. Build both roots in lockstep.
  //
  // Convert proof into a stack we pop from the back (proof[depth-1]).
  const p = proof.slice();
  function rec(m: number, n: number, complete: boolean): [Buffer, Buffer] {
    if (m === n) {
      // Both roots equal MTH(D[0:m]).
      // - complete=true   → this is the original rootM, no proof entry
      // - complete=false  → the next proof entry (from the FRONT) IS rootM
      const root = complete
        ? rootM
        : (p.length > 0 ? p.shift()! : (() => { throw new Error('proof exhausted'); })());
      return [root, root];
    }
    const k = largestPow2Below(n);
    if (m <= k) {
      // CRITICAL: outer-level sibling is the LAST element in p. Pop it
      // FIRST, then recurse — so inner pops see the array as it was
      // *before* the outer's sibling was appended by the generator.
      const rightSibling = p.pop();
      if (!rightSibling) throw new Error('proof exhausted (m <= k)');
      const [lm, ln] = rec(m, k, complete);
      return [lm, hashNode(ln, rightSibling)];
    }
    // m > k: left subtree is full size k in BOTH trees → left-subtree root is the same.
    const leftSibling = p.pop();
    if (!leftSibling) throw new Error('proof exhausted (m > k)');
    const [rm, rn] = rec(m - k, n - k, false);
    return [hashNode(leftSibling, rm), hashNode(leftSibling, rn)];
  }
  return rec(m, n, consumeRootM);
}
