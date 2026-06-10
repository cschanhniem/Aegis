#!/usr/bin/env node
/**
 * AEGIS transparency-log offline auditor.
 *
 * The whole point of a signed Merkle log is that a consumer can verify
 * AEGIS's claims WITHOUT trusting AEGIS at run time. This CLI bundles
 * the verification logic so the proofs can be checked from a customer's
 * own machine, in a CI job, by a regulator, etc.
 *
 * Four sub-commands:
 *
 *   verify-inclusion   Given a SignedRoot + leaf payload + proof, prove
 *                      the leaf is in the tree.
 *
 *   verify-consistency Given two SignedRoots + consistency proof, prove
 *                      the smaller tree is a prefix of the larger.
 *
 *   verify-cosign      Given a SignedRoot + a witness's public-key PEM
 *                      + the witness's signature, prove the witness
 *                      cosigned this STH.
 *
 *   help               Usage.
 *
 * Inputs are absolute file paths to JSON payloads pulled from the AEGIS
 * API. The CLI exits 0 on success, non-zero on any failure. Output is
 * one JSON object on stdout (machine-readable) and a human summary on
 * stderr.
 */

import { readFileSync } from 'node:fs'
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

const argv = process.argv.slice(2)
const cmd = argv[0]

function die(msg, code = 2) {
  console.error(`error: ${msg}`)
  process.exit(code)
}

function read(path) {
  if (!path) die('missing file path')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function hex(buf) { return buf.toString('hex') }
function fromHex(s) { return Buffer.from(s, 'hex') }
function fromB64u(s) {
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = std.length % 4
  return Buffer.from(pad ? std + '='.repeat(4 - pad) : std, 'base64')
}

// ── RFC 6962 hashing ───────────────────────────────────────────────────
function hashLeaf(payload) {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  return createHash('sha256').update(Buffer.from([0x00])).update(buf).digest()
}
function hashNode(l, r) {
  return createHash('sha256').update(Buffer.from([0x01])).update(l).update(r).digest()
}
function largestPow2Below(n) {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

// ── Inclusion recomputation (matches services/merkle.ts:recompute) ────
function recomputeRoot(leafHash, m, n, proof, depth) {
  if (depth === 0) {
    if (n !== 1) throw new Error('proof exhausted before single-leaf subtree')
    return leafHash
  }
  if (n < 2) throw new Error('proof has entries remaining but subtree size < 2')
  const k = largestPow2Below(n)
  const sib = proof[depth - 1]
  if (m < k) return hashNode(recomputeRoot(leafHash, m, k, proof, depth - 1), sib)
  return hashNode(sib, recomputeRoot(leafHash, m - k, n - k, proof, depth - 1))
}

// ── Consistency recomputation (matches services/merkle.ts) ────────────
function recomputeConsistency(m, n, rootM, proof, consumeRootM) {
  const p = proof.slice()
  function rec(m, n, complete) {
    if (m === n) {
      const root = complete ? rootM : (p.length > 0 ? p.shift() : (() => { throw new Error('proof exhausted') })())
      return [root, root]
    }
    const k = largestPow2Below(n)
    if (m <= k) {
      const rightSib = p.pop()
      if (!rightSib) throw new Error('proof exhausted (m <= k)')
      const [lm, ln] = rec(m, k, complete)
      return [lm, hashNode(ln, rightSib)]
    }
    const leftSib = p.pop()
    if (!leftSib) throw new Error('proof exhausted (m > k)')
    const [rm, rn] = rec(m - k, n - k, false)
    return [hashNode(leftSib, rm), hashNode(leftSib, rn)]
  }
  return rec(m, n, consumeRootM)
}
function isPow2(x) { return x > 0 && (x & (x - 1)) === 0 }

// ── Canonical JSON (matches services/transparency-log.ts) ────────────
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']'
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
}

// ── Commands ───────────────────────────────────────────────────────────

function cmdVerifyInclusion() {
  const proof = read(argv[1])
  const entry = argv[2] ? read(argv[2]) : null
  // proof.signed_root.root_hash + proof.proof[] + proof.leaf_hash
  if (!proof?.signed_root || !proof?.proof || !proof?.leaf_hash) die('proof JSON missing required fields')
  // Verify the leaf hash matches the payload (when supplied)
  if (entry?.payload) {
    const computedLeaf = hex(hashLeaf(entry.payload))
    if (computedLeaf !== proof.leaf_hash) {
      die(`leaf hash mismatch: payload hashes to ${computedLeaf}, proof claims ${proof.leaf_hash}`, 1)
    }
  }
  const rootBuf = fromHex(proof.signed_root.root_hash)
  const leafBuf = fromHex(proof.leaf_hash)
  const proofBufs = proof.proof.map(fromHex)
  const m = proof.index - 1   // 1-indexed → 0-indexed
  try {
    const recomputed = recomputeRoot(leafBuf, m, proof.tree_size, proofBufs, proofBufs.length)
    const match = recomputed.equals(rootBuf)
    if (!match) die('inclusion proof did NOT verify (recomputed root != signed root)', 1)
    process.stdout.write(JSON.stringify({ ok: true, kind: 'inclusion', tree_size: proof.tree_size, leaf_index: proof.index }) + '\n')
    console.error(`✓ leaf ${proof.index} verified against tree size ${proof.tree_size}`)
  } catch (err) {
    die(`inclusion verification failed: ${err.message}`, 1)
  }
}

function cmdVerifyConsistency() {
  const proof = read(argv[1])
  if (!proof?.signed_root_first || !proof?.signed_root_second || !Array.isArray(proof.proof)) {
    die('consistency JSON missing required fields')
  }
  const m = proof.first, n = proof.second
  const rootM = fromHex(proof.signed_root_first.root_hash)
  const rootN = fromHex(proof.signed_root_second.root_hash)
  const proofBufs = proof.proof.map(fromHex)
  try {
    if (m === 0)   { process.stdout.write(JSON.stringify({ ok: true, kind: 'consistency', trivial: 'empty prefix' }) + '\n'); console.error('✓ m=0; consistency trivially holds'); return }
    if (m === n)   {
      const eq = rootM.equals(rootN) && proofBufs.length === 0
      if (!eq) die('m == n but roots differ', 1)
      process.stdout.write(JSON.stringify({ ok: true, kind: 'consistency', trivial: 'identical' }) + '\n')
      console.error('✓ m=n; roots match identically'); return
    }
    const consumeRootM = isPow2(m)
    const [cm, cn] = recomputeConsistency(m, n, rootM, proofBufs, consumeRootM)
    if (!cm.equals(rootM) || !cn.equals(rootN)) {
      die(`consistency proof did NOT verify (recomputed roots don't match signed roots)`, 1)
    }
    process.stdout.write(JSON.stringify({ ok: true, kind: 'consistency', first: m, second: n }) + '\n')
    console.error(`✓ size-${m} tree is a prefix of size-${n} tree`)
  } catch (err) {
    die(`consistency verification failed: ${err.message}`, 1)
  }
}

function cmdVerifyCosign() {
  const sth = read(argv[1])
  const cosign = read(argv[2])
  const pubKeyPem = argv[3] ? readFileSync(argv[3], 'utf8') : null
  if (!pubKeyPem) die('cosignature verify needs the witness public-key PEM path as arg 3')
  if (!sth?.tree_size || !sth?.root_hash || !sth?.timestamp) die('sth JSON missing fields')
  if (!cosign?.signature) die('cosignature JSON missing signature')
  const signingBytes = canonical({ tree_size: sth.tree_size, root_hash: sth.root_hash, timestamp: sth.timestamp })
  try {
    const pub = createPublicKey({ key: pubKeyPem, format: 'pem', type: 'spki' })
    const ok = cryptoVerify(null, Buffer.from(signingBytes, 'utf8'), pub, fromB64u(cosign.signature))
    if (!ok) die('witness signature does NOT verify against the supplied STH', 1)
    process.stdout.write(JSON.stringify({ ok: true, kind: 'cosign', tree_size: sth.tree_size, root_hash: sth.root_hash }) + '\n')
    console.error(`✓ witness signature verifies for tree_size=${sth.tree_size}`)
  } catch (err) {
    die(`cosignature verification failed: ${err.message}`, 1)
  }
}

function help() {
  console.error(`AEGIS transparency-log offline auditor

Usage:
  verify-log verify-inclusion   <proof.json> [entry.json]
  verify-log verify-consistency <consistency.json>
  verify-log verify-cosign      <sth.json> <cosign.json> <witness_pubkey.pem>
  verify-log help

Each JSON file is the body returned by the matching AEGIS endpoint:
  /api/v1/transparency-log/proof/:idx          → proof.json
  /api/v1/transparency-log/proof-by-hash       → proof.json
  /api/v1/transparency-log/entry/:idx          → entry.json
  /api/v1/transparency-log/consistency         → consistency.json
  /api/v1/witness/sth-to-sign  (the .sth)      → sth.json
  /api/v1/witness/signatures   (one element)   → cosign.json

Exit 0 on success, non-zero on any verification failure or bad input.
Pure-Node, no external dependencies — auditable in a single source file.`)
}

if (cmd === 'verify-inclusion')         cmdVerifyInclusion()
else if (cmd === 'verify-consistency')  cmdVerifyConsistency()
else if (cmd === 'verify-cosign')       cmdVerifyCosign()
else { help(); process.exit(cmd ? 2 : 0) }
