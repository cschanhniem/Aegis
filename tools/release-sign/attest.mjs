#!/usr/bin/env node
// AEGIS SLSA v1.0 provenance attester.
//
// Produces an in-toto Statement (https://in-toto.io/Statement/v1) with a
// SLSA Provenance v1.0 predicate (https://slsa.dev/spec/v1.0/provenance),
// then signs the canonical-JSON encoding with the AEGIS release signing
// key. The output is a single .attestation.sig.json sidecar:
//
//   {
//     spec_version: "1.0.0",
//     attestation: <signed-input string of the in-toto statement>,
//     signature: <base64 ed25519 sig>,
//     public_key_pem: <PEM>
//   }
//
// Customers verify by recomputing the artifact SHA-256, comparing
// against statement.subject[0].digest.sha256, then verifying the
// Ed25519 signature with verify.mjs (same flow as the existing
// release signature).
//
// Usage:
//   node tools/release-sign/attest.mjs \
//     --in     <artifact>           \  # path to the file
//     --key    <privkey.pem>        \  # signing key
//     --out    <artifact.attestation.sig.json>
//     [--source-uri    git+https://github.com/Justin0504/Aegis@<sha>]
//     [--build-id      <CI run id>]
//     [--builder-uri   <CI workflow url>]
//     [--started-on    <ISO8601>]
//     [--finished-on   <ISO8601>]
//     [--sbom          <path-to-cyclonedx-or-spdx-json>]

import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { argv, exit, env } from 'node:process';

function parseArgs() {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    const v = argv[i + 1];
    if (!k || v === undefined) usage('missing value for argument');
    args[k] = v;
  }
  return args;
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('Usage: attest.mjs --in <artifact> --key <privkey.pem> --out <manifest> [--source-uri ...] [--sbom ...]');
  exit(2);
}

const args = parseArgs();
if (!args.in || !args.key || !args.out) usage();

function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}

try {
  const artifact = await readFile(args.in);
  const sha256 = createHash('sha256').update(artifact).digest('hex');

  const privPem = await readFile(args.key, 'utf8');
  const privKey = createPrivateKey(privPem);
  if (privKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`expected ed25519 private key; got ${privKey.asymmetricKeyType}`);
  }
  const pubPem = createPublicKey(privKey).export({ type: 'spki', format: 'pem' }).toString().trim();

  let sbomDigest;
  if (args.sbom) {
    const sbomBuf = await readFile(args.sbom);
    sbomDigest = createHash('sha256').update(sbomBuf).digest('hex');
  }

  const sourceUri = args['source-uri']
    ?? (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_SHA
        ? `git+${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}@${env.GITHUB_SHA}`
        : 'unknown');
  const builderUri = args['builder-uri']
    ?? (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_WORKFLOW_REF
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/.github/workflows/${env.GITHUB_WORKFLOW_REF.split('/').pop()}`
        : 'unknown');
  const buildId = args['build-id']
    ?? env.GITHUB_RUN_ID
    ?? 'unknown';
  const startedOn = args['started-on'] ?? new Date().toISOString();
  const finishedOn = args['finished-on'] ?? new Date().toISOString();

  // in-toto Statement + SLSA v1.0 Provenance predicate.
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: basename(args.in),
      digest: { sha256 },
    }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://github.com/Justin0504/Aegis/builds/v1',
        externalParameters: {
          source: sourceUri,
          ref: env.GITHUB_REF ?? args['ref'] ?? 'unknown',
        },
        internalParameters: {
          node_version: env.NODE_VERSION ?? process.version,
          platform:     `${process.platform}-${process.arch}`,
        },
        ...(sbomDigest ? { resolvedDependencies: [{ name: 'sbom', digest: { sha256: sbomDigest } }] } : {}),
      },
      runDetails: {
        builder: { id: builderUri },
        metadata: {
          invocationId: buildId,
          startedOn,
          finishedOn,
        },
      },
    },
  };

  const signedInput = canonical(statement);
  const sig = edSign(null, Buffer.from(signedInput, 'utf8'), privKey);

  const manifest = {
    spec_version: '1.0.0',
    statement,                 // human-readable copy (verifier ignores; uses signed_input)
    signed_input: signedInput,
    signature: sig.toString('base64'),
    public_key_pem: pubPem,
  };
  await writeFile(args.out, JSON.stringify(manifest, null, 2));
  console.log(`attested ${args.in} → ${args.out}  (sha256=${sha256.slice(0, 12)}…)`);
} catch (err) {
  console.error(`attest failed: ${err.message}`);
  exit(1);
}
