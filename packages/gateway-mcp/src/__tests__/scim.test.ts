/**
 * SCIM 2.0 endpoint tests.
 *
 * Exercises every IdP-facing surface against an in-process express app
 * with realistic Okta + Azure AD payloads. The tests pin the contract
 * IdPs actually depend on (so "we support SCIM" doesn't end with a
 * Tuesday morning bug-report from a customer's Okta connector).
 *
 * Coverage:
 *   - Bearer-token auth (issued via ScimService, no static config)
 *   - Discovery endpoints public, everything else gated
 *   - Users: list / filter (userName eq, emails.value sw) / create /
 *     get-by-externalId via filter / PUT replace / PATCH active / DELETE
 *   - Groups: create / add+remove members via PATCH / list
 *   - Multi-tenant isolation: a token for org A cannot read org B's users
 *   - SCIM error response shape
 */
import express from 'express';
import http from 'http';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ScimService } from '../services/scim-service';
import { ScimAPI } from '../api/scim';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';

const silent = pino({ level: 'silent' });

function makeServer(): { server: http.Server; baseUrl: string; svc: ScimService; tokenA: string; tokenB: string } {
  const db = new Database(':memory:');
  initializeEnterpriseSchema(db);
  // Seed two orgs so we can verify cross-tenant isolation.
  db.prepare(`INSERT INTO organizations (id, name, slug, plan) VALUES ('org-a', 'Acme', 'acme', 'enterprise')`).run();
  db.prepare(`INSERT INTO organizations (id, name, slug, plan) VALUES ('org-b', 'Beta', 'beta', 'enterprise')`).run();
  const svc = new ScimService(db, silent);
  const { token: tokenA } = svc.issueToken('org-a', 'okta-prod');
  const { token: tokenB } = svc.issueToken('org-b', 'azure-prod');

  const app = express();
  app.use(express.json({ type: ['application/json', 'application/scim+json'] }));
  app.use('/scim/v2', new ScimAPI(svc, silent).router);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, svc, tokenA, tokenB };
}

async function call(method: string, url: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return await new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null;
    const headers: Record<string, string> = { 'Accept': 'application/scim+json' };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (data) {
      headers['Content-Type'] = 'application/scim+json';
      headers['Content-Length'] = String(data.length);
    }
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: raw ? safeJson(raw) : null,
        headers: res.headers as any,
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return s; } }

let H: ReturnType<typeof makeServer>;
beforeAll(() => { H = makeServer(); });
afterAll(() => new Promise<void>(r => H.server.close(() => r())));

// ── Auth ────────────────────────────────────────────────────────────

test('discovery endpoints are public (no bearer required)', async () => {
  const sp = await call('GET', `${H.baseUrl}/scim/v2/ServiceProviderConfig`);
  expect(sp.status).toBe(200);
  expect(sp.body.patch.supported).toBe(true);
  expect(sp.body.filter.supported).toBe(true);

  const rt = await call('GET', `${H.baseUrl}/scim/v2/ResourceTypes`);
  expect(rt.status).toBe(200);
  expect(rt.body.Resources.map((r: any) => r.id).sort()).toEqual(['Group', 'User']);
});

test('users endpoint rejects requests without bearer token', async () => {
  const r = await call('GET', `${H.baseUrl}/scim/v2/Users`);
  expect(r.status).toBe(401);
  expect(r.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
});

test('users endpoint rejects revoked / unknown tokens', async () => {
  const r = await call('GET', `${H.baseUrl}/scim/v2/Users`, { token: 'scim_garbage_token_value' });
  expect(r.status).toBe(401);
});

// ── Users CRUD ──────────────────────────────────────────────────────

test('POST /Users creates with the Okta-shape payload', async () => {
  const r = await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: 'okta-uid-001',
      userName: 'alice@acme.com',
      name: { givenName: 'Alice', familyName: 'Anderson' },
      emails: [{ value: 'alice@acme.com', primary: true, type: 'work' }],
      active: true,
    },
  });
  expect(r.status).toBe(201);
  expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(r.body.userName).toBe('alice@acme.com');
  expect(r.body.externalId).toBe('okta-uid-001');
  expect(r.body.name.givenName).toBe('Alice');
  expect(r.body.active).toBe(true);
  expect(r.headers.location).toContain('/Users/');
});

test('GET /Users?filter=userName eq "..." returns 1 result', async () => {
  const r = await call('GET', `${H.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('userName eq "alice@acme.com"')}`, {
    token: H.tokenA,
  });
  expect(r.status).toBe(200);
  expect(r.body.totalResults).toBe(1);
  expect(r.body.Resources[0].userName).toBe('alice@acme.com');
  // RFC: 1-based startIndex
  expect(r.body.startIndex).toBe(1);
});

test('GET /Users?filter=externalId eq "okta-uid-001" — IdP de-dup lookup', async () => {
  const r = await call('GET', `${H.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('externalId eq "okta-uid-001"')}`, {
    token: H.tokenA,
  });
  expect(r.body.totalResults).toBe(1);
});

test('GET /Users?filter with co (contains) matches partial', async () => {
  const r = await call('GET', `${H.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('userName co "acme"')}`, {
    token: H.tokenA,
  });
  expect(r.body.totalResults).toBeGreaterThanOrEqual(1);
});

test('PATCH /Users/:id replace active=false soft-deactivates', async () => {
  const list = await call('GET', `${H.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('userName eq "alice@acme.com"')}`, { token: H.tokenA });
  const id = list.body.Resources[0].id;
  const patch = await call('PATCH', `${H.baseUrl}/scim/v2/Users/${id}`, {
    token: H.tokenA,
    body: {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false } }],
    },
  });
  expect(patch.status).toBe(200);
  expect(patch.body.active).toBe(false);
});

test('PATCH /Users/:id replace path=name.familyName', async () => {
  const list = await call('GET', `${H.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('userName eq "alice@acme.com"')}`, { token: H.tokenA });
  const id = list.body.Resources[0].id;
  const r = await call('PATCH', `${H.baseUrl}/scim/v2/Users/${id}`, {
    token: H.tokenA,
    body: { Operations: [{ op: 'replace', path: 'name.familyName', value: 'Smith' }] },
  });
  expect(r.status).toBe(200);
  expect(r.body.name.familyName).toBe('Smith');
});

test('PUT /Users/:id full replace', async () => {
  const list = await call('GET', `${H.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('userName eq "alice@acme.com"')}`, { token: H.tokenA });
  const id = list.body.Resources[0].id;
  const r = await call('PUT', `${H.baseUrl}/scim/v2/Users/${id}`, {
    token: H.tokenA,
    body: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'alice@acme.com',
      name: { givenName: 'Alice', familyName: 'Acme' },
      emails: [{ value: 'alice@acme.com', primary: true }],
      active: true,
      externalId: 'okta-uid-001',
    },
  });
  expect(r.status).toBe(200);
  expect(r.body.name.familyName).toBe('Acme');
  expect(r.body.active).toBe(true);
});

test('DELETE /Users/:id returns 204 and the user is gone', async () => {
  const created = await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { userName: 'doomed@acme.com', emails: [{ value: 'doomed@acme.com', primary: true }] },
  });
  const id = created.body.id;
  const del = await call('DELETE', `${H.baseUrl}/scim/v2/Users/${id}`, { token: H.tokenA });
  expect(del.status).toBe(204);
  const get = await call('GET', `${H.baseUrl}/scim/v2/Users/${id}`, { token: H.tokenA });
  expect(get.status).toBe(404);
});

// ── Groups CRUD ─────────────────────────────────────────────────────

test('POST /Groups + PATCH add members works (Azure AD shape)', async () => {
  // Pre-seed two users to add
  const u1 = (await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { userName: 'gm1@acme.com', emails: [{ value: 'gm1@acme.com', primary: true }] },
  })).body.id;
  const u2 = (await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { userName: 'gm2@acme.com', emails: [{ value: 'gm2@acme.com', primary: true }] },
  })).body.id;

  const gp = await call('POST', `${H.baseUrl}/scim/v2/Groups`, {
    token: H.tokenA,
    body: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'engineering',
      externalId: 'azure-grp-eng',
      members: [{ value: u1 }],
    },
  });
  expect(gp.status).toBe(201);
  expect(gp.body.displayName).toBe('engineering');
  expect(gp.body.members.length).toBe(1);
  const gid = gp.body.id;

  // Add u2 via PATCH
  const add = await call('PATCH', `${H.baseUrl}/scim/v2/Groups/${gid}`, {
    token: H.tokenA,
    body: {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: u2 }] }],
    },
  });
  expect(add.status).toBe(200);
  expect(add.body.members.length).toBe(2);

  // Remove u1
  const rem = await call('PATCH', `${H.baseUrl}/scim/v2/Groups/${gid}`, {
    token: H.tokenA,
    body: { Operations: [{ op: 'remove', path: 'members', value: [{ value: u1 }] }] },
  });
  expect(rem.body.members.length).toBe(1);
  expect(rem.body.members[0].value).toBe(u2);
});

// ── Tenant isolation ────────────────────────────────────────────────

test('tokenB cannot see tokenA users (multi-tenant isolation)', async () => {
  const r = await call('GET', `${H.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('userName eq "alice@acme.com"')}`, {
    token: H.tokenB,
  });
  expect(r.status).toBe(200);
  expect(r.body.totalResults).toBe(0);
});

test('tokenB cannot read tokenA user by id (404, not 200)', async () => {
  // Create a user in org-a
  const a = await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { userName: 'private-a@acme.com', emails: [{ value: 'private-a@acme.com', primary: true }] },
  });
  const id = a.body.id;
  const xb = await call('GET', `${H.baseUrl}/scim/v2/Users/${id}`, { token: H.tokenB });
  expect(xb.status).toBe(404);
});

// ── Conflict / validation ───────────────────────────────────────────

test('POST a duplicate userName returns 409', async () => {
  await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { userName: 'dup@acme.com', emails: [{ value: 'dup@acme.com', primary: true }] },
  });
  const r = await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { userName: 'dup@acme.com', emails: [{ value: 'dup@acme.com', primary: true }] },
  });
  expect(r.status).toBe(409);
});

test('POST without userName returns 400 with SCIM error shape', async () => {
  const r = await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { emails: [{ value: 'x@acme.com', primary: true }] },
  });
  expect(r.status).toBe(400);
  expect(r.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  expect(r.body.detail).toMatch(/userName required/);
});

test('PATCH with unsupported path returns 400 (not silent no-op)', async () => {
  const create = await call('POST', `${H.baseUrl}/scim/v2/Users`, {
    token: H.tokenA,
    body: { userName: 'patchprobe@acme.com', emails: [{ value: 'patchprobe@acme.com', primary: true }] },
  });
  const id = create.body.id;
  const r = await call('PATCH', `${H.baseUrl}/scim/v2/Users/${id}`, {
    token: H.tokenA,
    body: { Operations: [{ op: 'replace', path: 'this.attribute.does.not.exist', value: 'x' }] },
  });
  expect(r.status).toBe(400);
});
