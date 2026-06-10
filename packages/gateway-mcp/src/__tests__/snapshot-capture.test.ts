/**
 * SnapshotCaptureService tests. Exercises:
 *
 *   - inline_args (zero config baseline)
 *   - webhook variant: success / timeout / 5xx falls back to inline_args
 *   - db_row variant: SQL template renders + hits the bridge
 *   - persistence + hash determinism (canonical JSON)
 *   - retrieval by trace_id
 */

import Database from 'better-sqlite3';
import pino from 'pino';
import http from 'http';
import { AddressInfo } from 'net';
import { SnapshotCaptureService } from '../services/snapshot-capture';

function setup() {
  const db = new Database(':memory:');
  return { db, svc: new SnapshotCaptureService(db, pino({ level: 'silent' })) };
}

function startEchoServer(handler: (body: any) => { status: number; body?: any }) {
  return new Promise<{ url: string; close: () => Promise<void>; received: any[] }>(resolve => {
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', c => { buf += c; });
      req.on('end', () => {
        const body = (() => { try { return JSON.parse(buf); } catch { return null; } })();
        received.push(body);
        const r = handler(body);
        res.statusCode = r.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r.body ?? {}));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/snapshot`,
        close: () => new Promise(r => server.close(() => r())),
        received,
      });
    });
  });
}

describe('SnapshotCaptureService', () => {
  it('no config → no capture (returns ok:true with no snapshot)', async () => {
    const { svc } = setup();
    const r = await svc.capture({ orgId: 'org-1', trace_id: 't1', tool_name: 'send_email', arguments: { to: 'x' } });
    expect(r.ok).toBe(true);
    expect(r.snapshot).toBeUndefined();
  });

  it('inline_args: pre_state = arguments verbatim, hash deterministic', async () => {
    const { svc } = setup();
    svc.setConfig('org-1', { snapshots: { db_insert: { kind: 'inline_args' } } });
    const r = await svc.capture({
      orgId: 'org-1', trace_id: 't1', tool_name: 'db_insert',
      arguments: { table: 'users', row_id: 42 },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot!.kind).toBe('inline_args');
    expect(r.snapshot!.snapshot_data).toEqual({ table: 'users', row_id: 42 });
    expect(r.snapshot!.hash).toMatch(/^[0-9a-f]{64}$/);
    // Persisted
    const fetched = svc.get('t1');
    expect(fetched).not.toBeNull();
    expect(fetched!.kind).toBe('inline_args');
  });

  it('hash is canonical (same content, different key order → same hash)', async () => {
    const { svc } = setup();
    svc.setConfig('org-1', { snapshots: { x: { kind: 'inline_args' } } });
    const a = await svc.capture({ orgId: 'org-1', trace_id: 'ta', tool_name: 'x', arguments: { a: 1, b: 2 } });
    const b = await svc.capture({ orgId: 'org-1', trace_id: 'tb', tool_name: 'x', arguments: { b: 2, a: 1 } });
    expect(a.snapshot!.hash).toBe(b.snapshot!.hash);
  });

  it('webhook: fetches pre_state from operator bridge', async () => {
    const { svc } = setup();
    const srv = await startEchoServer(() => ({
      status: 200,
      body: { previous_row: { id: 42, balance: 100 } },
    }));
    try {
      svc.setConfig('org-1', {
        snapshots: { db_update: { kind: 'webhook', url: srv.url, timeout_ms: 2000 } },
      });
      const r = await svc.capture({
        orgId: 'org-1', trace_id: 't-wh', tool_name: 'db_update',
        arguments: { id: 42, new_balance: 200 },
      });
      expect(r.ok).toBe(true);
      expect(r.snapshot!.kind).toBe('webhook');
      expect((r.snapshot!.snapshot_data as any).previous_row.balance).toBe(100);
      // Bridge received the call shape we expect
      expect(srv.received).toHaveLength(1);
      expect(srv.received[0].phase).toBe('pre_state_capture');
      expect(srv.received[0].arguments.id).toBe(42);
    } finally { await srv.close(); }
  });

  it('webhook timeout → falls back to inline_args, logs error', async () => {
    const { svc } = setup();
    // Server that never responds
    const stuck = http.createServer(() => { /* leak */ });
    await new Promise(r => stuck.listen(0, () => r(null)));
    const port = (stuck.address() as AddressInfo).port;
    try {
      svc.setConfig('org-1', {
        snapshots: { db_update: { kind: 'webhook', url: `http://127.0.0.1:${port}/x`, timeout_ms: 150 } },
      });
      const r = await svc.capture({
        orgId: 'org-1', trace_id: 't-to', tool_name: 'db_update', arguments: { id: 1 },
      });
      expect(r.ok).toBe(true);
      expect(r.fallback).toBe('inline_args');
      expect(r.snapshot!.kind).toBe('inline_args');
      expect(r.snapshot!.snapshot_data).toEqual({ id: 1 });
      expect(r.error).toMatch(/timed out/);
    } finally { stuck.closeAllConnections?.(); stuck.close(); }
  }, 10000);

  it('webhook 5xx → falls back to inline_args', async () => {
    const { svc } = setup();
    const srv = await startEchoServer(() => ({ status: 503, body: { error: 'busy' } }));
    try {
      svc.setConfig('org-1', {
        snapshots: { db_update: { kind: 'webhook', url: srv.url, timeout_ms: 1000 } },
      });
      const r = await svc.capture({
        orgId: 'org-1', trace_id: 't-503', tool_name: 'db_update', arguments: { id: 1 },
      });
      expect(r.ok).toBe(true);
      expect(r.fallback).toBe('inline_args');
      expect(r.error).toMatch(/503/);
    } finally { await srv.close(); }
  });

  it('db_row: renders SQL template + sends to bridge', async () => {
    const { svc } = setup();
    const srv = await startEchoServer(body => {
      // The bridge should receive the rendered SQL
      expect(body.sql).toBe('SELECT * FROM accounts WHERE id = 42');
      return { status: 200, body: [{ id: 42, balance: 100 }] };
    });
    try {
      svc.setConfig('org-1', {
        snapshots: { db_update: {
          kind: 'db_row', url: srv.url,
          sql: 'SELECT * FROM accounts WHERE id = {{trace.tool_call.arguments.id}}',
          timeout_ms: 1000,
        } },
      });
      const r = await svc.capture({
        orgId: 'org-1', trace_id: 't-db', tool_name: 'db_update',
        arguments: { id: 42, new_balance: 200 },
      });
      expect(r.ok).toBe(true);
      expect(r.snapshot!.kind).toBe('db_row');
      expect((r.snapshot!.snapshot_data as any)[0].balance).toBe(100);
    } finally { await srv.close(); }
  });

  it('get returns null on unknown trace_id', () => {
    const { svc } = setup();
    expect(svc.get('nope')).toBeNull();
  });

  it('REPLACE semantics: re-capturing same trace_id overwrites prior snapshot', async () => {
    const { svc } = setup();
    svc.setConfig('org-1', { snapshots: { x: { kind: 'inline_args' } } });
    await svc.capture({ orgId: 'org-1', trace_id: 'same', tool_name: 'x', arguments: { v: 1 } });
    await svc.capture({ orgId: 'org-1', trace_id: 'same', tool_name: 'x', arguments: { v: 2 } });
    const fetched = svc.get('same');
    expect((fetched!.snapshot_data as any).v).toBe(2);
  });

  it('lookup scopes to tenant — cross-tenant doesn\'t leak', () => {
    const { svc } = setup();
    svc.setConfig('org-A', { snapshots: { x: { kind: 'inline_args' } } });
    expect(svc.lookup('org-A', 'x')).not.toBeNull();
    expect(svc.lookup('org-B', 'x')).toBeNull();
  });
});
