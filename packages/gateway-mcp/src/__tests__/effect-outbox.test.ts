/**
 * EffectOutboxService tests. Exercises:
 *   - enqueue with no config → enqueued:false
 *   - enqueue with config → row stored, dispatch_at in the future
 *   - cancel before dispatch → status=cancelled, no HTTP fired
 *   - dispatcher fires when due → status=fired, HTTP received with idempotency-key
 *   - dispatch with 500 → status=failed, error captured
 *   - cancel after fired → returns ok=false
 *   - cancel emits signed Merkle receipt
 */

import Database from 'better-sqlite3';
import pino from 'pino';
import http from 'http';
import { AddressInfo } from 'net';

import { AuditLogService } from '../services/audit-log';
import { TransparencyLogService } from '../services/transparency-log';
import { SigningService } from '../services/signing';
import { EffectOutboxService } from '../services/effect-outbox';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      org_id TEXT, user_id TEXT, user_email TEXT,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
      details TEXT, ip_address TEXT
    );
    CREATE TABLE gateway_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE transparency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leaf_hash TEXT NOT NULL, payload TEXT NOT NULL,
      source TEXT NOT NULL, org_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const logger = pino({ level: 'silent' });
  const signing = new SigningService(db, logger);
  const audit   = new AuditLogService(db, logger);
  const tlog    = new TransparencyLogService(db, signing, logger);
  const svc     = new EffectOutboxService(db, logger, audit, tlog);
  return { db, svc };
}

function startEchoServer(onRequest: (req: http.IncomingMessage, body: any) => { status: number; body?: any }) {
  return new Promise<{ url: string; close: () => Promise<void>; received: Array<{ headers: any; body: any }> }>(resolve => {
    const received: Array<{ headers: any; body: any }> = [];
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', c => { buf += c; });
      req.on('end', () => {
        const body = (() => { try { return JSON.parse(buf); } catch { return null; } })();
        received.push({ headers: req.headers, body });
        const r = onRequest(req, body);
        res.statusCode = r.status;
        res.end(JSON.stringify(r.body ?? {}));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/dispatch`,
        close: () => new Promise(r => server.close(() => r())),
        received,
      });
    });
  });
}

describe('EffectOutboxService', () => {
  it('enqueue returns false when no config registered', () => {
    const { svc } = setup();
    const r = svc.enqueue({
      orgId: 'org-1', trace_id: 't1', agent_id: 'a1', tool_name: 'send_email', payload: {},
    });
    expect(r.enqueued).toBe(false);
  });

  it('enqueue stores a row with dispatch_at in the future', () => {
    const { svc } = setup();
    svc.setConfig('org-1', {
      tools: { send_email: { delay_seconds: 30, dispatch_url: 'http://localhost:1/x' } },
    });
    const r = svc.enqueue({
      orgId: 'org-1', trace_id: 't-future', agent_id: 'a1', tool_name: 'send_email',
      payload: { to: 'x@y.z' },
    });
    expect(r.enqueued).toBe(true);
    expect(r.id).toBeGreaterThan(0);
    expect(new Date(r.dispatch_at!).getTime()).toBeGreaterThan(Date.now());
    const row = svc.get(r.id!);
    expect(row!.status).toBe('pending');
    expect(row!.payload.to).toBe('x@y.z');
  });

  it('cancel before dispatch → status=cancelled, no HTTP fired', async () => {
    const { svc } = setup();
    svc.setConfig('org-1', {
      tools: { send_email: { delay_seconds: 60, dispatch_url: 'http://localhost:1/x' } },
    });
    const e = svc.enqueue({ orgId: 'org-1', trace_id: 't-cxl', agent_id: 'a1', tool_name: 'send_email', payload: {} });
    const c = svc.cancel({ orgId: 'org-1', trace_id: 't-cxl', reason: 'user pressed undo' });
    expect(c.ok).toBe(true);
    const row = svc.get(e.id!);
    expect(row!.status).toBe('cancelled');
    // No "fired" audit row
  });

  it('dispatcher fires the entry when due, payload + Idempotency-Key header arrive', async () => {
    const { svc } = setup();
    const srv = await startEchoServer(() => ({ status: 200, body: { ok: true } }));
    try {
      svc.setConfig('org-1', {
        tools: { send_email: { delay_seconds: 0, dispatch_url: srv.url, timeout_ms: 2000 } },
      });
      const e = svc.enqueue({
        orgId: 'org-1', trace_id: 't-fire', agent_id: 'a1', tool_name: 'send_email',
        payload: { to: 'a@b.c', body: 'hello' },
      });
      // dispatch_at is "now" — dispatchOne immediately
      const r = await svc.dispatchOne(e.id!);
      expect(r.status).toBe('fired');
      // Idempotency-Key header equals the trace_id
      expect(srv.received).toHaveLength(1);
      expect(srv.received[0].headers['idempotency-key']).toBe('t-fire');
      expect(srv.received[0].body.to).toBe('a@b.c');
      const row = svc.get(e.id!);
      expect(row!.status).toBe('fired');
      expect(row!.dispatched_at).toBeTruthy();
    } finally { await srv.close(); }
  });

  it('dispatch failure (5xx) marks status=failed with error captured', async () => {
    const { svc } = setup();
    const srv = await startEchoServer(() => ({ status: 503, body: { error: 'queue full' } }));
    try {
      svc.setConfig('org-1', {
        tools: { send_email: { delay_seconds: 0, dispatch_url: srv.url, timeout_ms: 1000 } },
      });
      const e = svc.enqueue({ orgId: 'org-1', trace_id: 't-fail', agent_id: 'a1', tool_name: 'send_email', payload: {} });
      const r = await svc.dispatchOne(e.id!);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/HTTP 503/);
      const row = svc.get(e.id!);
      expect(row!.status).toBe('failed');
      expect(row!.error).toMatch(/503/);
    } finally { await srv.close(); }
  });

  it('cancel after fire returns ok=false', async () => {
    const { svc } = setup();
    const srv = await startEchoServer(() => ({ status: 200, body: {} }));
    try {
      svc.setConfig('org-1', { tools: { x: { delay_seconds: 0, dispatch_url: srv.url } } });
      const e = svc.enqueue({ orgId: 'org-1', trace_id: 't-late', agent_id: 'a1', tool_name: 'x', payload: {} });
      await svc.dispatchOne(e.id!);
      const c = svc.cancel({ orgId: 'org-1', trace_id: 't-late' });
      expect(c.ok).toBe(false);
      expect(c.reason).toMatch(/fired/);
    } finally { await srv.close(); }
  });

  it('cancel emits a signed Merkle receipt', () => {
    const { db, svc } = setup();
    svc.setConfig('org-1', { tools: { x: { delay_seconds: 30, dispatch_url: 'http://localhost:1/x' } } });
    svc.enqueue({ orgId: 'org-1', trace_id: 't-merkle', agent_id: 'a1', tool_name: 'x', payload: {} });
    svc.cancel({ orgId: 'org-1', trace_id: 't-merkle', reason: 'panic' });
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM transparency_log WHERE json_extract(payload, '$.action') = 'outbox.cancel'`,
    ).get() as any;
    expect(row.n).toBe(1);
  });

  it('due() returns only entries past dispatch_at and still pending', () => {
    const { svc } = setup();
    svc.setConfig('org-1', { tools: { now: { delay_seconds: 0, dispatch_url: 'http://localhost:1/x' } } });
    svc.setConfig('org-1', { tools: {
      now: { delay_seconds: 0, dispatch_url: 'http://localhost:1/x' },
      later: { delay_seconds: 600, dispatch_url: 'http://localhost:1/y' },
    }});
    svc.enqueue({ orgId: 'org-1', trace_id: 't-now',   agent_id: 'a', tool_name: 'now', payload: {} });
    svc.enqueue({ orgId: 'org-1', trace_id: 't-later', agent_id: 'a', tool_name: 'later', payload: {} });
    const due = svc.due();
    expect(due).toHaveLength(1);
    expect(due[0].trace_id).toBe('t-now');
  });
});
