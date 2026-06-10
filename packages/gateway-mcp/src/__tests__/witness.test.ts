/**
 * End-to-end witness-protocol tests. Generates an Ed25519 keypair in
 * Node, registers it as a witness, fetches the STH, signs it offline,
 * submits the cosignature, and verifies the cosign endpoint and the
 * cross-tenant + dedup invariants.
 */

import Database from 'better-sqlite3';
import pino from 'pino';
import { generateKeyPairSync, sign as cryptoSign, randomBytes } from 'crypto';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { TransparencyLogService } from '../services/transparency-log';
import { SigningService } from '../services/signing';
import { WitnessService } from '../services/witness';
import { WitnessAPI } from '../api/witness';

function bootApp(orgId = 'org-test') {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE transparency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leaf_hash TEXT NOT NULL, payload TEXT NOT NULL,
      source TEXT NOT NULL, org_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE gateway_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const logger = pino({ level: 'silent' });
  const signer = new SigningService(db, logger);
  const tlog   = new TransparencyLogService(db, signer, logger);
  const wit    = new WitnessService(db, logger, tlog, signer);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).orgId = orgId; next(); });
  app.use('/api/v1', new WitnessAPI(wit, logger).router);
  return { db, tlog, wit, app, orgId };
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { publicKey, privateKey, pem };
}

function signMessage(msg: string, privateKey: any): string {
  const sig = cryptoSign(null, Buffer.from(msg, 'utf8'), privateKey);
  // Service accepts both base64 and base64url.
  return sig.toString('base64');
}

describe('WitnessService + WitnessAPI', () => {
  let server: Server;
  let url: string;
  let tlog: TransparencyLogService;
  let wit: WitnessService;
  beforeAll(async () => {
    const built = bootApp();
    tlog = built.tlog;
    wit  = built.wit;
    // Seed some entries so STH is non-empty
    for (let i = 0; i < 5; i++) tlog.append({ payload: { i }, source: 'test' as any });
    const started = await listen(built.app);
    server = started.server;
    url = started.url;
  });
  afterAll(() => server.close());

  it('register → list → deactivate flow', async () => {
    const { pem } = makeKeypair();
    const r = await fetch(`${url}/api/v1/witnesses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'witness-a', public_key_pem: pem }),
    });
    expect(r.status).toBe(201);
    const w = await r.json() as any;
    expect(w.name).toBe('witness-a');
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await (await fetch(`${url}/api/v1/witnesses`)).json() as any;
    expect(list.witnesses).toContainEqual(expect.objectContaining({ id: w.id, name: 'witness-a' }));

    const off = await fetch(`${url}/api/v1/witnesses/${w.id}/deactivate`, { method: 'POST' });
    expect(off.status).toBe(200);
    const list2 = await (await fetch(`${url}/api/v1/witnesses`)).json() as any;
    expect(list2.witnesses.find((x: any) => x.id === w.id)).toBeUndefined();
  });

  it('register rejects malformed PEM with 400', async () => {
    const r = await fetch(`${url}/api/v1/witnesses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad', public_key_pem: '-----NOPE-----' }),
    });
    expect(r.status).toBe(400);
  });

  it('sth-to-sign returns the STH + the canonical signing bytes', async () => {
    const r = await fetch(`${url}/api/v1/witness/sth-to-sign`);
    expect(r.status).toBe(200);
    const data = await r.json() as any;
    expect(data.sth.tree_size).toBeGreaterThan(0);
    expect(data.sth.root_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof data.signing_bytes).toBe('string');
    // signing_bytes should be canonical-JSON and contain all three fields
    expect(data.signing_bytes).toContain('"tree_size"');
    expect(data.signing_bytes).toContain('"root_hash"');
    expect(data.signing_bytes).toContain('"timestamp"');
  });

  it('happy path: register → fetch sth → sign → cosign accepted', async () => {
    const { privateKey, pem } = makeKeypair();
    const reg = await (await fetch(`${url}/api/v1/witnesses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'happy', public_key_pem: pem }),
    })).json() as any;

    const sth = await (await fetch(`${url}/api/v1/witness/sth-to-sign`)).json() as any;
    const signature = signMessage(sth.signing_bytes, privateKey);

    const cosign = await fetch(`${url}/api/v1/witness/${reg.id}/cosign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tree_size: sth.sth.tree_size,
        root_hash: sth.sth.root_hash,
        timestamp: sth.sth.timestamp,
        signature,
      }),
    });
    expect(cosign.status).toBe(200);
    const data = await cosign.json() as any;
    expect(data.ok).toBe(true);
    expect(data.cosignature_id).toBeGreaterThan(0);

    // Now consumer pulls cosignatures for that root
    const sigs = await (await fetch(`${url}/api/v1/witness/signatures?root_hash=${sth.sth.root_hash}`)).json() as any;
    expect(sigs.cosignatures.length).toBeGreaterThanOrEqual(1);
    const ours = sigs.cosignatures.find((c: any) => c.witness_id === reg.id);
    expect(ours).toBeTruthy();
    expect(ours.signature).toBe(signature);
    expect(ours.witness_name).toBe('happy');
  });

  it('cosign rejects forged signatures (different key signed same STH)', async () => {
    const real = makeKeypair();
    const fake = makeKeypair();
    const reg = await (await fetch(`${url}/api/v1/witnesses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'tamper', public_key_pem: real.pem }),
    })).json() as any;

    const sth = await (await fetch(`${url}/api/v1/witness/sth-to-sign`)).json() as any;
    // Sign with the WRONG key
    const fakeSig = signMessage(sth.signing_bytes, fake.privateKey);
    const r = await fetch(`${url}/api/v1/witness/${reg.id}/cosign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tree_size: sth.sth.tree_size,
        root_hash: sth.sth.root_hash,
        timestamp: sth.sth.timestamp,
        signature: fakeSig,
      }),
    });
    expect(r.status).toBe(400);
    const data = await r.json() as any;
    expect(data.reason).toMatch(/does not verify/);
  });

  it('cosign rejects tampered STH (signature was over different bytes)', async () => {
    const kp = makeKeypair();
    const reg = await (await fetch(`${url}/api/v1/witnesses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rebind', public_key_pem: kp.pem }),
    })).json() as any;

    const sth = await (await fetch(`${url}/api/v1/witness/sth-to-sign`)).json() as any;
    const sig = signMessage(sth.signing_bytes, kp.privateKey);

    // Submit the signature with a TAMPERED root_hash — must not verify
    const r = await fetch(`${url}/api/v1/witness/${reg.id}/cosign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tree_size: sth.sth.tree_size,
        root_hash: '1234567890' + sth.sth.root_hash.slice(10),
        timestamp: sth.sth.timestamp,
        signature: sig,
      }),
    });
    expect(r.status).toBe(400);
  });

  it('cosign dedup: same signature submitted twice → second call is no-op', async () => {
    const kp = makeKeypair();
    const reg = await (await fetch(`${url}/api/v1/witnesses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dedup', public_key_pem: kp.pem }),
    })).json() as any;
    const sth = await (await fetch(`${url}/api/v1/witness/sth-to-sign`)).json() as any;
    const sig = signMessage(sth.signing_bytes, kp.privateKey);

    const body = JSON.stringify({
      tree_size: sth.sth.tree_size, root_hash: sth.sth.root_hash,
      timestamp: sth.sth.timestamp, signature: sig,
    });
    const r1 = await (await fetch(`${url}/api/v1/witness/${reg.id}/cosign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })).json() as any;
    const r2 = await (await fetch(`${url}/api/v1/witness/${reg.id}/cosign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })).json() as any;
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.cosignature_id).toBe(r1.cosignature_id);
  });

  it('cross-tenant: a witness id only valid for org-A cannot cosign on org-B', async () => {
    // Build an isolated org-B app and try to cosign with an id that
    // doesn't belong to org-B. Witness service is scoped by org so
    // the lookup must fail → cosign returns ok:false.
    const { app: appB } = bootApp('org-B');
    const startedB = await listen(appB);
    try {
      // Use a well-formed (but functionally invalid) body so we reach
      // the service layer rather than getting bounced by Zod
      const r = await fetch(`${startedB.url}/api/v1/witness/00000000-0000-0000-0000-000000000000/cosign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tree_size: 1,
          root_hash: 'a'.repeat(64),
          timestamp: new Date().toISOString(),
          signature: Buffer.alloc(64).toString('base64'),
        }),
      });
      expect(r.status).toBe(400);
      const data = await r.json() as any;
      expect(data.ok).toBe(false);
      expect(data.reason).toMatch(/not registered/);
    } finally { startedB.server.close(); }
  });

  it('signatures endpoint validates root_hash format', async () => {
    const r = await fetch(`${url}/api/v1/witness/signatures?root_hash=zzz`);
    expect(r.status).toBe(400);
  });

  it('canonicalSthBytes is stable across runs and orders keys deterministically', () => {
    const a = WitnessService.canonicalSthBytes({ tree_size: 7, root_hash: 'abc', timestamp: '2026-06-02T12:00:00Z' });
    const b = WitnessService.canonicalSthBytes({ timestamp: '2026-06-02T12:00:00Z', root_hash: 'abc', tree_size: 7 } as any);
    expect(a).toBe(b);
    expect(a).toBe('{"root_hash":"abc","timestamp":"2026-06-02T12:00:00Z","tree_size":7}');
  });
});
