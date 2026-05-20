/**
 * Alignment API — endpoint-level tests for the /recent listing.
 *
 * We don't exercise POST /check here because it hits a live LLM
 * (Anthropic / OpenAI / Gemini). Network + cost + flakiness ratio
 * is wrong for unit tests. The service-layer LLM judge is already
 * covered by alignment-checker.test.ts. This file injects fixture
 * audit-log rows directly and verifies the GET /recent contract
 * — that's the surface a user-facing Cockpit hits every 15 s.
 */

import express from 'express';
import pino from 'pino';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { AuditLogService } from '../services/audit-log';
import { AlignmentAPI } from '../api/alignment';

const silent = pino({ level: 'silent' });

interface Harness {
  baseUrl: string;
  server: Server;
  db: Database.Database;
  audit: AuditLogService;
}

async function createHarness(): Promise<Harness> {
  const db = new Database(':memory:');
  initializeEnterpriseSchema(db);
  const audit = new AuditLogService(db, silent);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).orgId = 'default';
    next();
  });
  app.use('/api/v1/alignment', new AlignmentAPI(silent, audit, db).router);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, server, db, audit };
}

async function tearDown(h: Harness) {
  await new Promise<void>((r) => h.server.close(() => r()));
  h.db.close();
}

/** Inject a fake alignment audit row, mimicking what AlignmentAPI
 *  POST handler would write after a real /check. */
function injectAuditRow(
  audit: AuditLogService,
  agent_id: string,
  details: Record<string, unknown>,
) {
  audit.log({
    org_id: 'default',
    action: 'judge.trace',
    resource_type: 'agent',
    resource_id: agent_id,
    details: { kind: 'alignment', ...details },
    ip_address: '127.0.0.1',
  });
}

describe('AlignmentAPI', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await tearDown(h); });

  test('GET /recent returns empty list when no audits exist', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/alignment/recent`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: any[]; limit: number };
    expect(data.items).toEqual([]);
    expect(data.limit).toBe(20);
  });

  test('GET /recent returns injected rows in most-recent-first order', async () => {
    injectAuditRow(h.audit, 'agent-A', {
      score: 0.9,
      drifted: false,
      signals: [],
      model: 'claude-haiku-4-5',
    });
    injectAuditRow(h.audit, 'agent-B', {
      score: 0.3,
      drifted: true,
      signals: ['scope-expansion'],
      reason: 'Agent drifted into a delete operation',
      model: 'claude-haiku-4-5',
    });

    const res = await fetch(`${h.baseUrl}/api/v1/alignment/recent`);
    const data = (await res.json()) as { items: any[] };
    expect(data.items.length).toBe(2);
    // Most-recent first (agent-B was logged last).
    expect(data.items[0].agent_id).toBe('agent-B');
    expect(data.items[0].drifted).toBe(true);
    expect(data.items[0].signals).toEqual(['scope-expansion']);
    expect(data.items[0].reason).toBe('Agent drifted into a delete operation');
    expect(data.items[1].agent_id).toBe('agent-A');
    expect(data.items[1].drifted).toBe(false);
  });

  test('GET /recent respects limit param and clamps to [1, 100]', async () => {
    const r1 = await fetch(`${h.baseUrl}/api/v1/alignment/recent?limit=1`);
    const d1 = (await r1.json()) as { items: any[]; limit: number };
    expect(d1.limit).toBe(1);
    expect(d1.items.length).toBe(1);

    const r2 = await fetch(`${h.baseUrl}/api/v1/alignment/recent?limit=999`);
    const d2 = (await r2.json()) as { limit: number };
    expect(d2.limit).toBe(100);

    const r3 = await fetch(`${h.baseUrl}/api/v1/alignment/recent?limit=0`);
    const d3 = (await r3.json()) as { limit: number };
    expect(d3.limit).toBe(1);
  });

  test('GET /recent filters by kind=alignment, skipping non-alignment audits', async () => {
    // Inject a code-shield row alongside the alignment ones from earlier.
    // Should not appear in alignment /recent.
    h.audit.log({
      org_id: 'default',
      action: 'judge.trace',
      resource_type: 'agent',
      resource_id: 'agent-shield',
      details: { kind: 'code_shield', worst: 'CRITICAL', unique_findings: 2 },
      ip_address: '127.0.0.1',
    });

    const res = await fetch(`${h.baseUrl}/api/v1/alignment/recent`);
    const data = (await res.json()) as { items: any[] };
    // Only the two alignment rows from the earlier test should appear.
    expect(data.items.every((it: any) => it.agent_id !== 'agent-shield')).toBe(true);
  });

  test('GET /recent shape matches Cockpit consumer expectations', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/alignment/recent?limit=5`);
    const data = (await res.json()) as { items: any[]; limit: number };
    expect(typeof data.limit).toBe('number');
    expect(Array.isArray(data.items)).toBe(true);
    // Each item must carry the fields the AlignmentPanel reads.
    for (const it of data.items) {
      expect(it).toHaveProperty('id');
      expect(it).toHaveProperty('agent_id');
      expect(it).toHaveProperty('created_at');
      expect(it).toHaveProperty('score');
      expect(it).toHaveProperty('drifted');
      expect(it).toHaveProperty('signals');
    }
  });
});
