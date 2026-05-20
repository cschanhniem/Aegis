/**
 * Policy DSL API — endpoint-level tests.
 *
 * Complements policy-dsl.test.ts (parser + evaluator + service)
 * by exercising the REST surface the Cockpit's /dsl page actually
 * hits: GET / PUT / DELETE /api/v1/dsl, POST /dry-run, GET /examples.
 *
 * Auth + orgId scoping are tested via a minimal middleware that
 * stamps a fixed orgId on the request — the real requireAuth path
 * is exercised in the auth middleware tests.
 */

import express from 'express';
import pino from 'pino';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { ConfigBus } from '../services/config-bus';
import { TenantConfigService } from '../services/tenant-config';
import { AuditLogService } from '../services/audit-log';
import { DslPolicyService } from '../services/policy-dsl';
import { PolicyDslAPI } from '../api/policy-dsl';

const silent = pino({ level: 'silent' });

interface Harness {
  baseUrl: string;
  server: Server;
  db: Database.Database;
  tenantConfig: TenantConfigService;
}

async function createHarness(): Promise<Harness> {
  const db = new Database(':memory:');
  initializeEnterpriseSchema(db);
  const bus = new ConfigBus(silent);
  const audit = new AuditLogService(db, silent);
  const tenantConfig = new TenantConfigService(db, silent, bus, audit);
  tenantConfig.seedDefaults();
  const dsl = new DslPolicyService(silent, bus, tenantConfig);
  dsl.warmCache(['default']);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).orgId = 'default';
    (req as any).user = { email: 'tester@local' };
    next();
  });
  app.use('/api/v1/dsl', new PolicyDslAPI(tenantConfig, dsl, silent).router);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, server, db, tenantConfig };
}

async function tearDown(h: Harness) {
  await new Promise<void>((r) => h.server.close(() => r()));
  h.db.close();
}

describe('PolicyDslAPI', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await tearDown(h); });

  test('GET /examples returns the builtin catalog', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/dsl/examples`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { examples: any[] };
    expect(data.examples.length).toBeGreaterThan(3);
    // Spot-check shape required by Cockpit's dropdown picker.
    for (const ex of data.examples) {
      expect(typeof ex.id).toBe('string');
      expect(typeof ex.name).toBe('string');
      expect(typeof ex.description).toBe('string');
      expect(ex.dsl?.version).toBe(1);
      expect(Array.isArray(ex.dsl?.rules)).toBe(true);
    }
    // The two examples added for the new signals must be present.
    const ids = data.examples.map((e: any) => e.id);
    expect(ids).toContain('block-unsafe-code-gen');
    expect(ids).toContain('pause-on-alignment-drift');
  });

  test('GET / returns null when no DSL is saved', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/dsl`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { dsl: unknown };
    expect(data.dsl).toBeNull();
  });

  test('PUT / persists a valid DSL', async () => {
    const body = {
      version: 1,
      rules: [
        {
          name: 'pending-on-anomaly',
          when: { 'anomaly.score': { '>': 0.7 } },
          then: { decision: 'pending', reason: 'high anomaly' },
        },
      ],
    };
    const res = await fetch(`${h.baseUrl}/api/v1/dsl`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { dsl: any };
    expect(data.dsl.rules.length).toBe(1);

    // GET reflects the saved state.
    const after = await fetch(`${h.baseUrl}/api/v1/dsl`);
    const got = (await after.json()) as { dsl: any };
    expect(got.dsl.rules[0].name).toBe('pending-on-anomaly');
  });

  test('PUT / rejects malformed DSL (zod schema)', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/dsl`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, rules: [] }), // version must be 1
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; details: unknown };
    expect(data.error).toMatch(/Invalid DSL/);
    expect(data.details).toBeDefined();
  });

  test('PUT / surfaces compile errors with 400', async () => {
    // Invalid regex inside `matches` — schema parses but compile fails.
    const res = await fetch(`${h.baseUrl}/api/v1/dsl`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        rules: [
          {
            name: 'bad-regex',
            when: { 'tool.args.url': { matches: '[invalid(' } },
            then: { decision: 'block' },
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error.length).toBeGreaterThan(0);
  });

  test('POST /dry-run evaluates without persisting', async () => {
    const body = {
      dsl: {
        version: 1,
        rules: [
          {
            name: 'pending-high-anomaly',
            when: { 'anomaly.score': { '>': 0.7 } },
            then: { decision: 'pending', reason: 'anomaly above 0.7' },
          },
        ],
      },
      context: { anomaly: { score: 0.85 } },
    };
    const res = await fetch(`${h.baseUrl}/api/v1/dsl/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { match: any };
    expect(data.match?.decision).toBe('pending');
    expect(data.match?.ruleName).toBe('pending-high-anomaly');

    // Saved DSL is unchanged — dry-run must not mutate.
    const saved = await fetch(`${h.baseUrl}/api/v1/dsl`);
    const got = (await saved.json()) as { dsl: any };
    expect(got.dsl.rules[0].name).toBe('pending-on-anomaly');
  });

  test('POST /dry-run with no matching context returns match=null', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/dsl/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dsl: {
          version: 1,
          rules: [
            { name: 'shell-only', when: { 'classifier.category': 'shell' }, then: { decision: 'block' } },
          ],
        },
        context: { classifier: { category: 'network' } },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { match: unknown };
    expect(data.match).toBeNull();
  });

  test('DELETE / removes the saved DSL', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/dsl`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const after = await fetch(`${h.baseUrl}/api/v1/dsl`);
    const got = (await after.json()) as { dsl: unknown };
    expect(got.dsl).toBeNull();
  });
});
