/**
 * code-shield API — endpoint-level tests (router + DB + audit log).
 *
 * Complements code-shield.test.ts which tests the rule-matching
 * service in isolation. This file exercises the wired router so
 * the /scan → audit-log → /recent flow stays green under refactor.
 */

import express from 'express';
import pino from 'pino';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { AuditLogService } from '../services/audit-log';
import { CodeShieldAPI } from '../api/code-shield';

const silent = pino({ level: 'silent' });

interface Harness {
  baseUrl: string;
  server: Server;
  db: Database.Database;
}

async function createHarness(): Promise<Harness> {
  const db = new Database(':memory:');
  // CodeShieldAPI.recent reads admin_audit_log, which lives in the
  // enterprise schema. Initialize that explicitly here.
  initializeEnterpriseSchema(db);
  const audit = new AuditLogService(db, silent);

  const app = express();
  app.use(express.json());
  // Stamp a default orgId so the audit log scoping works without
  // having to mount requireAuth in the test harness.
  app.use((req, _res, next) => {
    (req as any).orgId = 'default';
    next();
  });
  app.use('/api/v1/code-shield', new CodeShieldAPI(silent, audit, db).router);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, server, db };
}

async function tearDown(h: Harness) {
  await new Promise<void>((r) => h.server.close(() => r()));
  h.db.close();
}

describe('CodeShieldAPI', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await tearDown(h); });

  test('GET /rules returns the live catalog', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/code-shield/rules`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { count: number; rules: any[] };
    expect(data.count).toBeGreaterThan(10);
    expect(data.rules.length).toBe(data.count);
    // Spot-check shape: every entry has id/severity/language.
    for (const r of data.rules) {
      expect(typeof r.id).toBe('string');
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(r.severity);
      expect(['any', 'python', 'javascript', 'shell', 'sql']).toContain(r.language);
    }
    // Confirm regex source is NOT exposed (contract: catch-what, not how).
    for (const r of data.rules) {
      expect(r.regex).toBeUndefined();
      expect(r.pattern).toBeUndefined();
    }
  });

  test('POST /scan returns findings and writes audit log on positive scan', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/code-shield/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'exec(user_input)',
        language: 'python',
        agent_id: 'test-agent-1',
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.worst).toBe('CRITICAL');
    expect(data.findings[0].rule).toBe('py.exec');

    // Audit log entry should exist with kind='code_shield'.
    const rows = h.db
      .prepare(
        "SELECT details FROM admin_audit_log WHERE action='judge.trace' ORDER BY id DESC LIMIT 1",
      )
      .all() as { details: string }[];
    expect(rows.length).toBe(1);
    const details = JSON.parse(rows[0].details);
    expect(details.kind).toBe('code_shield');
    expect(details.worst).toBe('CRITICAL');
    expect(details.rules).toContain('py.exec');
  });

  test('POST /scan does not write audit log on clean scan', async () => {
    const before = (h.db
      .prepare("SELECT COUNT(*) as n FROM admin_audit_log WHERE action='judge.trace'")
      .get() as { n: number }).n;
    const res = await fetch(`${h.baseUrl}/api/v1/code-shield/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'def add(a, b):\n    return a + b\n',
        language: 'python',
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.worst).toBeNull();
    const after = (h.db
      .prepare("SELECT COUNT(*) as n FROM admin_audit_log WHERE action='judge.trace'")
      .get() as { n: number }).n;
    expect(after).toBe(before); // unchanged
  });

  test('POST /scan rejects invalid body', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/code-shield/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'python' }), // missing code
    });
    expect(res.status).toBe(400);
  });

  test('GET /recent returns ordered findings list', async () => {
    // Seed a second scan to ensure ordering by id DESC.
    await fetch(`${h.baseUrl}/api/v1/code-shield/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'DROP TABLE archive;',
        language: 'sql',
        agent_id: 'test-agent-2',
      }),
    });

    const res = await fetch(`${h.baseUrl}/api/v1/code-shield/recent?limit=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: any[]; limit: number };
    expect(data.limit).toBe(10);
    // Most-recent first — agent-2 was the last scan to fire.
    expect(data.items[0].agent_id).toBe('test-agent-2');
    expect(data.items[0].worst).toBe('HIGH');
    expect(data.items[0].rules).toContain('sql.drop-table');
  });

  test('GET /recent respects limit param and clamps', async () => {
    const r1 = await fetch(`${h.baseUrl}/api/v1/code-shield/recent?limit=1`);
    const d1 = (await r1.json()) as { items: any[]; limit: number };
    expect(d1.limit).toBe(1);
    expect(d1.items.length).toBeLessThanOrEqual(1);

    // Out-of-range limits clamp to [1, 100], not 0 or negative.
    const r2 = await fetch(`${h.baseUrl}/api/v1/code-shield/recent?limit=99999`);
    const d2 = (await r2.json()) as { limit: number };
    expect(d2.limit).toBe(100);

    const r3 = await fetch(`${h.baseUrl}/api/v1/code-shield/recent?limit=0`);
    const d3 = (await r3.json()) as { limit: number };
    expect(d3.limit).toBe(1);
  });
});
