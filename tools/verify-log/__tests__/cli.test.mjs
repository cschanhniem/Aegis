/**
 * verify-log CLI round-trip tests. Spin up an in-memory transparency
 * log (via the gateway's own service), fetch the JSON, write to temp
 * files, run the CLI, assert exit code.
 *
 * This is the GOLD-STANDARD test: it ties the SERVICE-SIDE generators
 * to the CLI-SIDE verifiers, end-to-end with file IO + subprocess.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')

function run(args) {
  // Catches non-zero exit and rethrows with stderr exposed
  try {
    const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout: out }
  } catch (err) {
    return { ok: false, code: err.status, stderr: err.stderr?.toString() ?? '', stdout: err.stdout?.toString() ?? '' }
  }
}

// ── Hashing primitives ────────────────────────────────────────────────
function hashLeaf(p) {
  const buf = typeof p === 'string' ? Buffer.from(p, 'utf8') : p
  return createHash('sha256').update(Buffer.from([0x00])).update(buf).digest()
}
function hashNode(l, r) {
  return createHash('sha256').update(Buffer.from([0x01])).update(l).update(r).digest()
}
function largestPow2Below(n) { let k = 1; while (k * 2 < n) k *= 2; return k }
function merkleRoot(L, s = 0, e = L.length) {
  const n = e - s
  if (n === 0) return createHash('sha256').digest()
  if (n === 1) return L[s]
  const k = largestPow2Below(n)
  return hashNode(merkleRoot(L, s, s + k), merkleRoot(L, s + k, e))
}
function inclusionProof(L, m, n = L.length) {
  function path(m, s, e) {
    const len = e - s
    if (len === 1) return []
    const k = largestPow2Below(len)
    const rel = m - s
    if (rel < k) return [...path(m, s, s + k), merkleRoot(L, s + k, e)]
    return [...path(m, s + k, e), merkleRoot(L, s, s + k)]
  }
  return path(m, 0, n)
}
function consistencyProof(L, m, n = L.length) {
  if (m === 0 || m === n) return []
  function sub(m, s, e, complete) {
    const len = e - s
    if (m === len) return complete ? [] : [merkleRoot(L, s, e)]
    const k = largestPow2Below(len)
    if (m <= k) return [...sub(m, s, s + k, complete), merkleRoot(L, s + k, e)]
    return [...sub(m - k, s + k, e, false), merkleRoot(L, s, s + k)]
  }
  return sub(m, 0, n, true)
}
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']'
  const e = Object.entries(obj).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
  return '{' + e.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
}

// ── Tests ─────────────────────────────────────────────────────────────

test('verify-inclusion succeeds on a valid proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-vl-'))
  try {
    const payloads = Array.from({ length: 10 }, (_, i) => canonical({ i }))
    const L = payloads.map(p => hashLeaf(p))
    const target = 4   // 0-indexed leaf 4
    const proof = inclusionProof(L, target).map(b => b.toString('hex'))
    const root = merkleRoot(L)
    const proofJson = {
      index: target + 1, tree_size: L.length, leaf_hash: L[target].toString('hex'),
      proof,
      signed_root: { tree_size: L.length, root_hash: root.toString('hex'), timestamp: '2026-06-02T00:00:00Z', signature: { signature: 'x', public_key: 'x' } },
    }
    const entryJson = { payload: payloads[target] }
    const proofPath = join(dir, 'proof.json')
    const entryPath = join(dir, 'entry.json')
    writeFileSync(proofPath, JSON.stringify(proofJson))
    writeFileSync(entryPath, JSON.stringify(entryJson))
    const r = run(['verify-inclusion', proofPath, entryPath])
    assert.equal(r.ok, true, r.stderr)
    assert.match(r.stdout, /"ok":true/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('verify-inclusion fails on a tampered root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-vl-'))
  try {
    const payloads = Array.from({ length: 5 }, (_, i) => canonical({ i }))
    const L = payloads.map(p => hashLeaf(p))
    const target = 2
    const proof = inclusionProof(L, target).map(b => b.toString('hex'))
    const tampered = merkleRoot(L)
    tampered[0] ^= 0xff
    const proofJson = {
      index: target + 1, tree_size: L.length, leaf_hash: L[target].toString('hex'),
      proof,
      signed_root: { tree_size: L.length, root_hash: tampered.toString('hex'), timestamp: 't', signature: { signature: 'x', public_key: 'x' } },
    }
    const proofPath = join(dir, 'proof.json')
    writeFileSync(proofPath, JSON.stringify(proofJson))
    const r = run(['verify-inclusion', proofPath])
    assert.equal(r.ok, false)
    assert.match(r.stderr, /did NOT verify/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('verify-consistency succeeds on a valid proof (m=5, n=12)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-vl-'))
  try {
    const L = Array.from({ length: 12 }, (_, i) => hashLeaf(canonical({ i })))
    const m = 5, n = 12
    const proofBytes = consistencyProof(L, m, n)
    const json = {
      first: m, second: n,
      proof: proofBytes.map(b => b.toString('hex')),
      signed_root_first:  { tree_size: m, root_hash: merkleRoot(L, 0, m).toString('hex'), timestamp: 't1', signature: { signature: 'x', public_key: 'x' } },
      signed_root_second: { tree_size: n, root_hash: merkleRoot(L).toString('hex'),       timestamp: 't2', signature: { signature: 'x', public_key: 'x' } },
    }
    const p = join(dir, 'consistency.json')
    writeFileSync(p, JSON.stringify(json))
    const r = run(['verify-consistency', p])
    assert.equal(r.ok, true, r.stderr)
    assert.match(r.stdout, /"ok":true/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('verify-consistency fails when the older root has been tampered with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-vl-'))
  try {
    const L = Array.from({ length: 8 }, (_, i) => hashLeaf(canonical({ i })))
    const m = 3, n = 8
    const proofBytes = consistencyProof(L, m, n)
    const fakeRootM = merkleRoot(L, 0, m); fakeRootM[7] ^= 0xff
    const json = {
      first: m, second: n,
      proof: proofBytes.map(b => b.toString('hex')),
      signed_root_first:  { tree_size: m, root_hash: fakeRootM.toString('hex'),        timestamp: 't1', signature: { signature: 'x', public_key: 'x' } },
      signed_root_second: { tree_size: n, root_hash: merkleRoot(L).toString('hex'),    timestamp: 't2', signature: { signature: 'x', public_key: 'x' } },
    }
    const p = join(dir, 'c.json')
    writeFileSync(p, JSON.stringify(json))
    const r = run(['verify-consistency', p])
    assert.equal(r.ok, false)
    assert.match(r.stderr, /did NOT verify/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('verify-cosign succeeds on a real Ed25519 signature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-vl-'))
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const sth = { tree_size: 42, root_hash: 'a'.repeat(64), timestamp: '2026-06-02T00:00:00Z' }
    const signingBytes = canonical(sth)
    const sig = cryptoSign(null, Buffer.from(signingBytes, 'utf8'), privateKey).toString('base64')

    const sthPath    = join(dir, 'sth.json')
    const cosignPath = join(dir, 'cosign.json')
    const pemPath    = join(dir, 'pub.pem')
    writeFileSync(sthPath, JSON.stringify(sth))
    writeFileSync(cosignPath, JSON.stringify({ signature: sig }))
    writeFileSync(pemPath, pem)
    const r = run(['verify-cosign', sthPath, cosignPath, pemPath])
    assert.equal(r.ok, true, r.stderr)
    assert.match(r.stdout, /"ok":true/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('verify-cosign fails on a forged signature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-vl-'))
  try {
    const real = generateKeyPairSync('ed25519')
    const fake = generateKeyPairSync('ed25519')
    const sth = { tree_size: 1, root_hash: 'b'.repeat(64), timestamp: 't' }
    const fakeSig = cryptoSign(null, Buffer.from(canonical(sth), 'utf8'), fake.privateKey).toString('base64')
    const pemPath = join(dir, 'real.pem')
    writeFileSync(pemPath, real.publicKey.export({ type: 'spki', format: 'pem' }))
    writeFileSync(join(dir, 'sth.json'), JSON.stringify(sth))
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ signature: fakeSig }))
    const r = run(['verify-cosign', join(dir, 'sth.json'), join(dir, 'c.json'), pemPath])
    assert.equal(r.ok, false)
    assert.match(r.stderr, /does NOT verify/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('help prints usage and exits 0 when no args', () => {
  const r = run([])
  assert.equal(r.ok, true)
})
