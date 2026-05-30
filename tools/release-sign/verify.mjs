#!/usr/bin/env node
// AEGIS release-artifact verifier — pure, no AEGIS dependencies.
// A customer / mirror operator can copy this file to an air-gapped box,
// drop in the artifact + sidecar manifest + the AEGIS-published pubkey,
// and run a single command to confirm provenance.
//
// Usage:
//   node tools/release-sign/verify.mjs --in <artifact> --sig <manifest.sig.json> [--pubkey <pubkey.pem>]
//
// Exit codes:
//   0  signature valid AND (if --pubkey supplied) embedded pubkey matches
//   1  any check failed
//   2  bad arguments

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { argv, exit } from 'node:process';

function parseArgs() {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    const v = argv[i + 1];
    if (!k || !v) usage('missing value for argument');
    args[k] = v;
  }
  return args;
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('Usage: verify.mjs --in <artifact> --sig <manifest.sig.json> [--pubkey <pubkey.pem>]');
  exit(2);
}

const args = parseArgs();
if (!args.in || !args.sig) usage();

try {
  const artifact = await readFile(args.in);
  const sha256 = createHash('sha256').update(artifact).digest('hex');

  const manifest = JSON.parse(await readFile(args.sig, 'utf8'));
  if (!manifest.signed_input || !manifest.signature || !manifest.public_key_pem) {
    throw new Error('manifest missing required fields');
  }

  // 1. Verify signed_input claims the same artifact name + sha.
  const claim = JSON.parse(manifest.signed_input);
  if (claim.algorithm !== 'ed25519') {
    throw new Error(`unsupported algorithm: ${claim.algorithm}`);
  }
  if (claim.sha256 !== sha256) {
    throw new Error(`sha256 mismatch — artifact differs from what was signed (claim=${claim.sha256.slice(0, 12)}… local=${sha256.slice(0, 12)}…)`);
  }
  if (claim.artifact && claim.artifact !== basename(args.in)) {
    console.warn(`warn: filename in manifest (${claim.artifact}) differs from local (${basename(args.in)})`);
  }

  // 2. Cryptographic signature verifies against the embedded pubkey.
  const pub = createPublicKey(manifest.public_key_pem);
  const ok = edVerify(
    null,
    Buffer.from(manifest.signed_input, 'utf8'),
    pub,
    Buffer.from(manifest.signature, 'base64'),
  );
  if (!ok) throw new Error('signature did not verify against embedded public key');

  // 3. If --pubkey supplied, ALSO require the embedded pubkey to match
  //    the one the verifier already trusts. Defeats key-substitution.
  if (args.pubkey) {
    const trusted = (await readFile(args.pubkey, 'utf8')).trim();
    const embedded = manifest.public_key_pem.trim();
    if (trusted !== embedded) {
      throw new Error('embedded public key does NOT match trusted pubkey — possible substitution attack');
    }
  }

  console.log('OK');
  console.log(`  artifact:        ${basename(args.in)}`);
  console.log(`  sha256:          ${sha256}`);
  console.log(`  signed_at:       ${claim.signed_at}`);
  console.log(`  purpose:         ${claim.purpose ?? 'aegis-release'}`);
  console.log(`  pubkey matches:  ${args.pubkey ? 'yes' : 'embedded-only (consider --pubkey)'}`);
  exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  exit(1);
}
