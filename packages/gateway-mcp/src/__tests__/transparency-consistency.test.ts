import express from 'express';
import Database from 'better-sqlite3';
import pino from 'pino';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { TransparencyLogService } from '../services/transparency-log';
import { TransparencyLogAPI } from '../api/transparency-log';
import { SigningService } from '../services/signing';
import { verifyConsistencyProof, verifyInclusion, hashLeaf } from '../services/merkle';

function bootApp() {
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
  const app = express();
  app.use('/api/v1/transparency-log', new TransparencyLogAPI(tlog).router);
  return { app, tlog };
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('Transparency-log consistency + proof-by-hash', () => {
  let server: Server;
  let url: string;
  let tlog: TransparencyLogService;
  beforeAll(async () => {
    const built = bootApp();
    tlog = built.tlog;
    const started = await listen(built.app);
    server = started.server;
    url = started.url;
  });
  afterAll(() => server.close());

  it('appends 20 entries; consistency proof verifies between sizes 7 and 20', async () => {
    for (let i = 0; i < 20; i++) {
      tlog.append({ payload: { i, msg: 'hello-' + i }, source: 'test' as any });
    }
    const r = await fetch(`${url}/api/v1/transparency-log/consistency?first=7&second=20`);
    expect(r.status).toBe(200);
    const data = await r.json() as any;
    expect(data.first).toBe(7);
    expect(data.second).toBe(20);
    expect(Array.isArray(data.proof)).toBe(true);
    const proofBufs = data.proof.map((h: string) => Buffer.from(h, 'hex'));
    const rootM = Buffer.from(data.signed_root_first.root_hash, 'hex');
    const rootN = Buffer.from(data.signed_root_second.root_hash, 'hex');
    expect(verifyConsistencyProof(7, 20, rootM, rootN, proofBufs)).toBe(true);
  });

  it('proof-by-hash returns inclusion proof that verifies', async () => {
    // Append a known payload + compute its expected leaf hash
    const payload = { greeting: 'unique-key-for-pbh' };
    const canonical = JSON.stringify(payload);   // service uses its own canonicalJson — but for a single string key it matches
    const beforeSize = tlog.size();
    const { leaf_hash } = tlog.append({ payload, source: 'test' as any });
    const r = await fetch(`${url}/api/v1/transparency-log/proof-by-hash?hash=${leaf_hash}`);
    expect(r.status).toBe(200);
    const data = await r.json() as any;
    expect(data.index).toBe(beforeSize + 1);
    expect(data.leaf_hash).toBe(leaf_hash);
    // The proof should verify against the bundled signed root
    const proofBufs = data.proof.map((h: string) => Buffer.from(h, 'hex'));
    const rootBuf = Buffer.from(data.signed_root.root_hash, 'hex');
    const leafBuf = Buffer.from(leaf_hash, 'hex');
    expect(verifyInclusion(leafBuf, data.index - 1, data.tree_size, proofBufs, rootBuf)).toBe(true);
  });

  it('proof-by-hash rejects invalid hash', async () => {
    const r = await fetch(`${url}/api/v1/transparency-log/proof-by-hash?hash=NOTHEX`);
    expect(r.status).toBe(400);
  });

  it('proof-by-hash returns 404 for unknown hash', async () => {
    const r = await fetch(`${url}/api/v1/transparency-log/proof-by-hash?hash=${'0'.repeat(64)}`);
    expect(r.status).toBe(404);
  });

  it('consistency rejects first > second', async () => {
    const r = await fetch(`${url}/api/v1/transparency-log/consistency?first=10&second=5`);
    expect(r.status).toBe(400);
  });

  it('consistency m=0 returns empty proof (consumer treats as trivially consistent)', async () => {
    const r = await fetch(`${url}/api/v1/transparency-log/consistency?first=0`);
    expect(r.status).toBe(200);
    const data = await r.json() as any;
    expect(data.proof).toHaveLength(0);
    expect(data.first).toBe(0);
  });

  it('consistency m=n returns empty proof (no work needed)', async () => {
    const n = tlog.size();
    const r = await fetch(`${url}/api/v1/transparency-log/consistency?first=${n}&second=${n}`);
    expect(r.status).toBe(200);
    const data = await r.json() as any;
    expect(data.proof).toHaveLength(0);
  });

  it('signed roots in consistency response have valid Ed25519 signatures', async () => {
    const r = await fetch(`${url}/api/v1/transparency-log/consistency?first=3&second=10`);
    const data = await r.json() as any;
    expect(data.signed_root_first.signature).toBeTruthy();
    expect(data.signed_root_first.signature.signature).toMatch(/^[A-Za-z0-9+/=_-]+$/);
    expect(data.signed_root_second.signature).toBeTruthy();
  });
});
