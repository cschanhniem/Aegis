#!/usr/bin/env node
// AEGIS release-artifact signer.
//
// Usage:
//   node tools/release-sign/sign.mjs --in <artifact> --key <privkey.pem> --out <artifact.sig.json>
//
// The signing key is an Ed25519 private key in PEM form. The output is a
// JSON manifest containing the artifact's SHA-256, base64 signature over
// that hash, signing timestamp, and the public key (so verifiers don't
// have to fetch it separately for the happy path; verifiers SHOULD still
// cross-check the embedded pubkey against the AEGIS-published one).

import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
  console.error('Usage: sign.mjs --in <artifact> --key <privkey.pem> --out <manifest.sig.json> [--purpose <string>]');
  exit(2);
}

const args = parseArgs();
if (!args.in || !args.key || !args.out) usage();

try {
  const artifact = await readFile(args.in);
  const sha256 = createHash('sha256').update(artifact).digest('hex');

  const privPem = await readFile(args.key, 'utf8');
  const privKey = createPrivateKey(privPem);
  if (privKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`expected ed25519 private key; got ${privKey.asymmetricKeyType}`);
  }
  const pubKey = createPublicKey(privKey);
  const pubPem = pubKey.export({ type: 'spki', format: 'pem' });

  // Sign the artifact hash + name + purpose so the same hash can't be
  // replayed under a different filename or context.
  const signedInput = JSON.stringify({
    algorithm: 'ed25519',
    artifact: basename(args.in),
    sha256,
    purpose: args.purpose ?? 'aegis-release',
    signed_at: new Date().toISOString(),
  });
  const sig = edSign(null, Buffer.from(signedInput, 'utf8'), privKey);

  const manifest = {
    spec_version: '1.0.0',
    signed_input: signedInput,
    signature: sig.toString('base64'),
    public_key_pem: pubPem.toString().trim(),
  };
  await writeFile(args.out, JSON.stringify(manifest, null, 2));
  console.log(`signed ${args.in} → ${args.out}  (sha256=${sha256.slice(0, 12)}…)`);
} catch (err) {
  console.error(`sign failed: ${err.message}`);
  exit(1);
}
