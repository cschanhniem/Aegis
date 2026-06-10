/**
 * SCIM 2.0 (RFC 7644) Users + Groups service.
 *
 * Storage-backed Users/Groups CRUD that the SCIM REST layer wraps.
 * Honours the IdP semantics that real-world deployments require:
 *
 *   - `externalId` is the IdP-side stable identifier and the primary
 *     key the IdP uses across renames/email changes. Always indexed.
 *   - `userName` is what SCIM filter queries hit; we map it onto our
 *     internal `email` column (every major IdP sets userName=email).
 *   - `active=false` SOFT-deletes (status='disabled') so the legacy
 *     roster + audit trail keep working. Hard DELETE on the resource
 *     truly removes it; mirrors Okta's "deprovision vs delete" split.
 *   - Group membership uses our `group_members` join table with the
 *     internal UUID, NOT the externalId. The SCIM response constructs
 *     `$ref` URLs back from internal id.
 *
 * Multi-tenancy: every method scopes by `orgId`. The SCIM token used
 * to authenticate the IdP request determines the orgId; the IdP can
 * NEVER cross-tenant.
 *
 * RFC quirks the implementation pins:
 *   - List response wraps results in `Resources` with `totalResults`,
 *     `itemsPerPage`, `startIndex` (1-based, not 0-based).
 *   - Create returns 201 with the canonical resource shape.
 *   - PATCH uses op = 'add' | 'replace' | 'remove' on JSON Pointer paths.
 *     We honour the common-case patches (replace active, replace name,
 *     add/remove members on group) and 400 on the exotic ones.
 *   - All resource ids are lowercase UUIDs; SCIM doesn't require this
 *     but every real IdP we tested expects it.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { randomUUID, createHash, randomBytes } from 'crypto';
import { parseScimFilter, astToSql } from './scim-filter';
import type { Role } from './rbac';

const USER_ATTRS: Record<string, string> = {
  id: 'id', userName: 'email', email: 'email', emails: 'email',
  'emails.value': 'email', externalId: 'external_id',
  displayName: 'name', name: 'name', 'name.givenName': 'given_name',
  'name.familyName': 'family_name', active: 'active_int',
};

const GROUP_ATTRS: Record<string, string> = {
  id: 'id', displayName: 'display_name', externalId: 'external_id',
};

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string };
  displayName?: string;
  emails: Array<{ value: string; type?: string; primary?: boolean }>;
  active: boolean;
  groups?: Array<{ value: string; display: string }>;
  meta: { resourceType: 'User'; created: string; lastModified: string; location?: string };
}

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members: Array<{ value: string; display?: string }>;
  meta: { resourceType: 'Group'; created: string; lastModified: string; location?: string };
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  itemsPerPage: number;
  startIndex: number;
  Resources: T[];
}

const SCHEMAS_USER  = ['urn:ietf:params:scim:schemas:core:2.0:User'];
const SCHEMAS_GROUP = ['urn:ietf:params:scim:schemas:core:2.0:Group'];
const SCHEMAS_LIST  = ['urn:ietf:params:scim:api:messages:2.0:ListResponse'];

function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export class ScimService {
  constructor(private db: Database.Database, private logger: Logger) {}

  // ── Token management (IdP setup flow) ────────────────────────────

  /** Issue a SCIM bearer token. Plaintext is returned exactly once;
   *  only the hash persists. Operators copy the token into their IdP
   *  ("Provisioning → API integration" in Okta, "Enterprise app →
   *  Provisioning → Admin Credentials → Secret Token" in Azure AD). */
  issueToken(orgId: string, name: string): { id: string; token: string } {
    const id = randomUUID();
    const token = 'scim_' + randomBytes(24).toString('base64url');
    this.db.prepare(
      `INSERT INTO scim_tokens (id, org_id, name, token_hash) VALUES (?, ?, ?, ?)`,
    ).run(id, orgId, name, hashToken(token));
    this.logger.info({ id, orgId, name }, 'SCIM token issued');
    return { id, token };
  }

  /** Look up the org_id a presented token authenticates for. Returns
   *  null on unknown / revoked tokens (constant-time match). */
  resolveToken(plaintext: string): string | null {
    if (!plaintext.startsWith('scim_')) return null;
    const row = this.db.prepare(
      `SELECT org_id FROM scim_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
    ).get(hashToken(plaintext)) as any;
    return row?.org_id ?? null;
  }

  revokeToken(orgId: string, tokenId: string): boolean {
    const r = this.db.prepare(
      `UPDATE scim_tokens SET revoked_at = datetime('now') WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
    ).run(tokenId, orgId);
    return r.changes > 0;
  }

  listTokens(orgId: string): Array<{ id: string; name: string; created_at: string; revoked_at: string | null }> {
    return this.db.prepare(
      `SELECT id, name, created_at, revoked_at FROM scim_tokens WHERE org_id = ? ORDER BY created_at DESC`,
    ).all(orgId) as any;
  }

  // ── User CRUD ─────────────────────────────────────────────────────

  createUser(orgId: string, input: Partial<ScimUserResource>, locationBase?: string): ScimUserResource {
    if (!input.userName) throw new ScimError(400, 'userName required');
    const id = randomUUID();
    const email = input.userName.toLowerCase();
    const primaryEmail = input.emails?.find(e => e.primary)?.value ?? email;
    const active = input.active !== false;
    const given = input.name?.givenName ?? null;
    const family = input.name?.familyName ?? null;
    const display = input.displayName ?? ([given, family].filter(Boolean).join(' ').trim() || email);

    try {
      this.db.prepare(
        `INSERT INTO users (id, org_id, email, name, role, status, external_id, given_name, family_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, orgId, primaryEmail.toLowerCase(), display,
        'viewer' as Role, active ? 'active' : 'disabled',
        input.externalId ?? null, given, family,
      );
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) throw new ScimError(409, 'user already exists');
      throw err;
    }
    return this.getUser(orgId, id, locationBase)!;
  }

  getUser(orgId: string, id: string, locationBase?: string): ScimUserResource | null {
    const row = this.db.prepare(
      `SELECT id, org_id, email, name, given_name, family_name, status, external_id, created_at, updated_at
       FROM users WHERE id = ? AND org_id = ?`,
    ).get(id, orgId) as any;
    if (!row) return null;
    return this.rowToScimUser(row, locationBase);
  }

  /** Find a user by externalId (the IdP's UUID). IdPs frequently fetch
   *  by external_id before deciding whether to POST a new user. */
  getUserByExternalId(orgId: string, externalId: string, locationBase?: string): ScimUserResource | null {
    const row = this.db.prepare(
      `SELECT id, org_id, email, name, given_name, family_name, status, external_id, created_at, updated_at
       FROM users WHERE org_id = ? AND external_id = ?`,
    ).get(orgId, externalId) as any;
    if (!row) return null;
    return this.rowToScimUser(row, locationBase);
  }

  listUsers(
    orgId: string,
    opts: { filter?: string; startIndex?: number; count?: number; locationBase?: string },
  ): ScimListResponse<ScimUserResource> {
    const start = Math.max(1, opts.startIndex ?? 1);
    const count = Math.min(200, Math.max(0, opts.count ?? 100));
    const offset = start - 1;
    let where = `org_id = ?`;
    const params: any[] = [orgId];
    if (opts.filter && opts.filter.trim()) {
      const ast = parseScimFilter(opts.filter);
      const frag = astToSql(ast, USER_ATTRS);
      // `active_int` is a virtual column we project below.
      where += ` AND ${frag.where.replace(/\bactive_int\b/g, "CASE WHEN status='active' THEN 1 ELSE 0 END")}`;
      params.push(...frag.params);
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`).get(...params) as any).n;
    const rows = this.db.prepare(
      `SELECT id, org_id, email, name, given_name, family_name, status, external_id, created_at, updated_at
       FROM users WHERE ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    ).all(...params, count, offset) as any[];
    return {
      schemas: SCHEMAS_LIST,
      totalResults: total,
      itemsPerPage: count,
      startIndex: start,
      Resources: rows.map(r => this.rowToScimUser(r, opts.locationBase)),
    };
  }

  /** PUT — full replace. The IdP sends the canonical resource and we
   *  overwrite everything except id + org_id + created_at. */
  replaceUser(orgId: string, id: string, input: ScimUserResource, locationBase?: string): ScimUserResource {
    if (!this.userExists(orgId, id)) throw new ScimError(404, 'not found');
    const email = (input.userName || input.emails?.find(e => e.primary)?.value || '').toLowerCase();
    if (!email) throw new ScimError(400, 'userName required');
    this.db.prepare(
      `UPDATE users SET
         email = ?, name = ?, given_name = ?, family_name = ?, status = ?,
         external_id = ?, updated_at = datetime('now')
       WHERE id = ? AND org_id = ?`,
    ).run(
      email,
      input.displayName ?? ([input.name?.givenName, input.name?.familyName].filter(Boolean).join(' ').trim() || email),
      input.name?.givenName ?? null, input.name?.familyName ?? null,
      input.active === false ? 'disabled' : 'active',
      input.externalId ?? null, id, orgId,
    );
    return this.getUser(orgId, id, locationBase)!;
  }

  /** PATCH — partial update. We support the operations real IdPs send:
   *    [{ op: 'replace', value: { active: false } }]
   *    [{ op: 'replace', path: 'active', value: false }]
   *    [{ op: 'replace', path: 'name.familyName', value: 'Smith' }]
   *    [{ op: 'remove',  path: 'externalId' }]
   *  Unknown paths produce a 400 with a descriptive error rather than
   *  silently no-op. */
  patchUser(orgId: string, id: string, ops: Array<{ op: string; path?: string; value?: any }>, locationBase?: string): ScimUserResource {
    if (!this.userExists(orgId, id)) throw new ScimError(404, 'not found');
    for (const op of ops) {
      const verb = String(op.op || '').toLowerCase();
      if (verb !== 'replace' && verb !== 'add' && verb !== 'remove') throw new ScimError(400, `unknown op: ${op.op}`);
      if (!op.path) {
        // value-only replace: flat object of attributes to write through
        if (verb === 'remove') throw new ScimError(400, 'remove without path is invalid');
        const v = op.value ?? {};
        if (typeof v !== 'object') throw new ScimError(400, 'value must be object');
        if ('active' in v)      this.setColumn(orgId, id, 'status', v.active === false ? 'disabled' : 'active');
        if ('userName' in v)    this.setColumn(orgId, id, 'email', String(v.userName).toLowerCase());
        if ('externalId' in v)  this.setColumn(orgId, id, 'external_id', v.externalId);
        if ('displayName' in v) this.setColumn(orgId, id, 'name', v.displayName);
        if (v.name?.givenName !== undefined)  this.setColumn(orgId, id, 'given_name',  v.name.givenName);
        if (v.name?.familyName !== undefined) this.setColumn(orgId, id, 'family_name', v.name.familyName);
        continue;
      }
      const path = op.path;
      const writes: Record<string, any> = {
        'active':           ['status', op.value === false ? 'disabled' : 'active'],
        'userName':         ['email', verb === 'remove' ? '' : String(op.value).toLowerCase()],
        'externalId':       ['external_id', verb === 'remove' ? null : op.value],
        'displayName':      ['name', verb === 'remove' ? null : op.value],
        'name.givenName':   ['given_name', verb === 'remove' ? null : op.value],
        'name.familyName':  ['family_name', verb === 'remove' ? null : op.value],
      };
      const w = writes[path];
      if (!w) throw new ScimError(400, `unsupported PATCH path: ${path}`);
      this.setColumn(orgId, id, w[0], w[1]);
    }
    return this.getUser(orgId, id, locationBase)!;
  }

  /** Hard DELETE — Okta uses this when deletion is configured instead
   *  of deactivation. We keep the row's audit history in `audit_log`
   *  via the existing audit trail; the row itself is gone. */
  deleteUser(orgId: string, id: string): boolean {
    const r = this.db.prepare(`DELETE FROM users WHERE id = ? AND org_id = ?`).run(id, orgId);
    return r.changes > 0;
  }

  // ── Group CRUD ────────────────────────────────────────────────────

  createGroup(orgId: string, input: Partial<ScimGroupResource>, locationBase?: string): ScimGroupResource {
    if (!input.displayName) throw new ScimError(400, 'displayName required');
    const id = randomUUID();
    try {
      this.db.prepare(
        `INSERT INTO groups (id, org_id, external_id, display_name) VALUES (?, ?, ?, ?)`,
      ).run(id, orgId, input.externalId ?? null, input.displayName);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) throw new ScimError(409, 'group already exists');
      throw err;
    }
    const memberIds = (input.members ?? []).map(m => m.value).filter(Boolean);
    if (memberIds.length > 0) this.setGroupMembers(orgId, id, memberIds);
    return this.getGroup(orgId, id, locationBase)!;
  }

  getGroup(orgId: string, id: string, locationBase?: string): ScimGroupResource | null {
    const row = this.db.prepare(
      `SELECT id, org_id, external_id, display_name, created_at, updated_at
       FROM groups WHERE id = ? AND org_id = ?`,
    ).get(id, orgId) as any;
    if (!row) return null;
    return this.rowToScimGroup(row, locationBase);
  }

  listGroups(
    orgId: string,
    opts: { filter?: string; startIndex?: number; count?: number; locationBase?: string },
  ): ScimListResponse<ScimGroupResource> {
    const start = Math.max(1, opts.startIndex ?? 1);
    const count = Math.min(200, Math.max(0, opts.count ?? 100));
    const offset = start - 1;
    let where = `org_id = ?`;
    const params: any[] = [orgId];
    if (opts.filter && opts.filter.trim()) {
      const frag = astToSql(parseScimFilter(opts.filter), GROUP_ATTRS);
      where += ` AND ${frag.where}`;
      params.push(...frag.params);
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM groups WHERE ${where}`).get(...params) as any).n;
    const rows = this.db.prepare(
      `SELECT id, org_id, external_id, display_name, created_at, updated_at
       FROM groups WHERE ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    ).all(...params, count, offset) as any[];
    return {
      schemas: SCHEMAS_LIST,
      totalResults: total,
      itemsPerPage: count,
      startIndex: start,
      Resources: rows.map(r => this.rowToScimGroup(r, opts.locationBase)),
    };
  }

  /** PATCH a group — common case: add or remove members. */
  patchGroup(orgId: string, id: string, ops: Array<{ op: string; path?: string; value?: any }>, locationBase?: string): ScimGroupResource {
    const exists = this.db.prepare(`SELECT 1 FROM groups WHERE id = ? AND org_id = ?`).get(id, orgId);
    if (!exists) throw new ScimError(404, 'not found');
    for (const op of ops) {
      const verb = String(op.op || '').toLowerCase();
      if (op.path === 'displayName' && verb === 'replace') {
        this.db.prepare(`UPDATE groups SET display_name = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?`)
          .run(op.value, id, orgId);
        continue;
      }
      if (op.path === 'members' || op.path === undefined && Array.isArray(op.value?.members)) {
        const members = (op.path === 'members' ? op.value : op.value?.members) ?? [];
        const ids = (Array.isArray(members) ? members : []).map((m: any) => m.value).filter(Boolean);
        if (verb === 'add')     this.addGroupMembers(orgId, id, ids);
        else if (verb === 'remove') this.removeGroupMembers(orgId, id, ids);
        else if (verb === 'replace') this.setGroupMembers(orgId, id, ids);
        continue;
      }
      throw new ScimError(400, `unsupported group PATCH op: ${op.op} ${op.path ?? ''}`);
    }
    return this.getGroup(orgId, id, locationBase)!;
  }

  deleteGroup(orgId: string, id: string): boolean {
    const r = this.db.prepare(`DELETE FROM groups WHERE id = ? AND org_id = ?`).run(id, orgId);
    return r.changes > 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private userExists(orgId: string, id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM users WHERE id = ? AND org_id = ?`).get(id, orgId);
  }

  private setColumn(orgId: string, id: string, col: string, val: any): void {
    this.db.prepare(`UPDATE users SET ${col} = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?`).run(val, id, orgId);
  }

  private setGroupMembers(orgId: string, groupId: string, userIds: string[]): void {
    this.db.prepare(`DELETE FROM group_members WHERE group_id = ?`).run(groupId);
    this.addGroupMembers(orgId, groupId, userIds);
  }

  private addGroupMembers(orgId: string, groupId: string, userIds: string[]): void {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`);
    const userCheck = this.db.prepare(`SELECT 1 FROM users WHERE id = ? AND org_id = ?`);
    for (const uid of userIds) {
      if (userCheck.get(uid, orgId)) stmt.run(groupId, uid);
    }
  }

  private removeGroupMembers(_orgId: string, groupId: string, userIds: string[]): void {
    const stmt = this.db.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`);
    for (const uid of userIds) stmt.run(groupId, uid);
  }

  private listMembers(groupId: string): Array<{ value: string; display: string }> {
    return this.db.prepare(
      `SELECT u.id AS value, u.name AS display FROM group_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`,
    ).all(groupId) as any;
  }

  private listGroupsForUser(userId: string): Array<{ value: string; display: string }> {
    return this.db.prepare(
      `SELECT g.id AS value, g.display_name AS display FROM group_members gm
       JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?`,
    ).all(userId) as any;
  }

  private rowToScimUser(row: any, locationBase?: string): ScimUserResource {
    const email = row.email;
    return {
      schemas: SCHEMAS_USER,
      id: row.id,
      externalId: row.external_id ?? undefined,
      userName: email,
      name: {
        givenName:  row.given_name ?? undefined,
        familyName: row.family_name ?? undefined,
      },
      displayName: row.name ?? undefined,
      emails: [{ value: email, primary: true, type: 'work' }],
      active: row.status === 'active',
      groups: this.listGroupsForUser(row.id),
      meta: {
        resourceType: 'User',
        created: row.created_at,
        lastModified: row.updated_at,
        location: locationBase ? `${locationBase}/Users/${row.id}` : undefined,
      },
    };
  }

  private rowToScimGroup(row: any, locationBase?: string): ScimGroupResource {
    return {
      schemas: SCHEMAS_GROUP,
      id: row.id,
      externalId: row.external_id ?? undefined,
      displayName: row.display_name,
      members: this.listMembers(row.id),
      meta: {
        resourceType: 'Group',
        created: row.created_at,
        lastModified: row.updated_at,
        location: locationBase ? `${locationBase}/Groups/${row.id}` : undefined,
      },
    };
  }
}

/** Typed error the SCIM REST layer translates into a SCIM-shaped
 *  error response body (per RFC 7644 §3.12). */
export class ScimError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
