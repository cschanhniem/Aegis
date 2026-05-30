/**
 * AgentRegistryService — owns the `agents` table.
 *
 * Three writer-side responsibilities:
 *   1. register()          operator-initiated registration; optionally
 *                          mints a secret returned exactly once
 *   2. touch()             called from the auth/decision hot path on
 *                          every sighting; updates last_seen_at and
 *                          auto-creates 'unregistered' rows
 *   3. update / rotate /    operator lifecycle: change scope, rotate
 *      setStatus            secret, suspend, deprecate
 *
 * Read side: get(), list(), authorize() — the last is the call the auth
 * middleware uses to decide whether an incoming agent_id is allowed.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { createHash, randomBytes, randomUUID } from 'crypto';
import {
  AgentRegistrationInput,
  AgentRegistrationResponse,
  AgentStatus,
  AgentUpdateRequest,
  RegisteredAgent,
} from '@agentguard/core-schema';

const SECRET_PREFIX = 'aegis_a_';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function mintSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function rowToAgent(row: any): RegisteredAgent {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    owner_email: row.owner_email ?? undefined,
    declared_tools: row.declared_tools ? JSON.parse(row.declared_tools) : undefined,
    max_cost_daily_usd: row.max_cost_daily_usd ?? undefined,
    environments: row.environments ? JSON.parse(row.environments) : undefined,
    status: row.status as AgentStatus,
    has_secret: !!row.secret_hash,
    has_public_key: !!row.public_key_pem,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at ?? undefined,
  };
}

export interface AuthorizeResult {
  agent: RegisteredAgent;
  /** Convenience: whether the gate should block this call. */
  blocked: boolean;
  blockReason?: string;
  /** Used by audit-row attribution. */
  attributionStrength: 'strong' | 'weak';
}

export class AgentRegistryService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  /** Operator-initiated registration. If `id` is supplied and an
   *  unregistered row exists, it's promoted to active in place; otherwise
   *  a new row is created. Returns the plaintext secret iff requested. */
  register(opts: { orgId: string; req: AgentRegistrationInput }): AgentRegistrationResponse {
    const id = opts.req.id ?? randomUUID();
    const existing = this.getRow(id);

    let secret: string | undefined;
    let secretHash: string | null = null;
    if (opts.req.issue_secret) {
      secret = mintSecret();
      secretHash = sha256(secret);
    } else if (existing?.secret_hash) {
      secretHash = existing.secret_hash;   // preserve on re-register without rotate
    }

    const declared = opts.req.declared_tools ? JSON.stringify(opts.req.declared_tools) : null;
    const envs = opts.req.environments ? JSON.stringify(opts.req.environments) : null;

    if (existing) {
      this.db.prepare(
        `UPDATE agents SET
           org_id = ?, name = ?, description = ?, owner_email = ?,
           declared_tools = ?, max_cost_daily_usd = ?, environments = ?,
           status = 'active',
           secret_hash = COALESCE(?, secret_hash),
           public_key_pem = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        opts.orgId,
        opts.req.name ?? existing.name ?? null,
        opts.req.description ?? existing.description ?? null,
        opts.req.owner_email ?? existing.owner_email ?? null,
        declared ?? existing.declared_tools,
        opts.req.max_cost_daily_usd ?? existing.max_cost_daily_usd,
        envs ?? existing.environments,
        secretHash,
        opts.req.public_key_pem ?? existing.public_key_pem ?? null,
        id,
      );
    } else {
      this.db.prepare(
        `INSERT INTO agents
           (id, org_id, name, description, owner_email,
            declared_tools, max_cost_daily_usd, environments,
            status, secret_hash, public_key_pem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id, opts.orgId,
        opts.req.name ?? null,
        opts.req.description ?? null,
        opts.req.owner_email ?? null,
        declared, opts.req.max_cost_daily_usd ?? null, envs,
        secretHash, opts.req.public_key_pem ?? null,
      );
    }

    return { agent: this.get(id)!, secret };
  }

  /** Called from the hot path on every agent sighting. Idempotent. */
  touch(opts: { orgId: string; agentId: string }): void {
    try {
      const row = this.getRow(opts.agentId);
      if (row) {
        this.db.prepare(
          `UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?`,
        ).run(opts.agentId);
        return;
      }
      // First sighting → auto-record as unregistered.
      this.db.prepare(
        `INSERT OR IGNORE INTO agents (id, org_id, status, last_seen_at)
         VALUES (?, ?, 'unregistered', datetime('now'))`,
      ).run(opts.agentId, opts.orgId);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, agentId: opts.agentId }, 'agent touch failed');
    }
  }

  /** Auth-time identity check. Returns block decision + attribution
   *  strength for the audit layer. */
  authorize(opts: { orgId: string; agentId: string; presentedSecret?: string }): AuthorizeResult | null {
    this.touch(opts);
    const agent = this.get(opts.agentId);
    if (!agent) return null;   // touch should have created it; defensive

    // Hard block states.
    if (agent.status === 'suspended') {
      return { agent, blocked: true, blockReason: 'agent suspended', attributionStrength: 'weak' };
    }
    if (agent.status === 'deprecated') {
      return { agent, blocked: true, blockReason: 'agent deprecated', attributionStrength: 'weak' };
    }

    // If a secret is required on the row but the caller didn't present
    // one (or presented the wrong one), block.
    if (agent.has_secret) {
      if (!opts.presentedSecret) {
        return { agent, blocked: true, blockReason: 'agent secret required', attributionStrength: 'weak' };
      }
      const row = this.getRow(opts.agentId);
      if (sha256(opts.presentedSecret) !== row!.secret_hash) {
        return { agent, blocked: true, blockReason: 'agent secret mismatch', attributionStrength: 'weak' };
      }
    }

    return {
      agent,
      blocked: false,
      attributionStrength: agent.status === 'active' ? 'strong' : 'weak',
    };
  }

  update(opts: { orgId: string; agentId: string; req: AgentUpdateRequest }): RegisteredAgent | null {
    const existing = this.getRow(opts.agentId);
    if (!existing || existing.org_id !== opts.orgId) return null;

    const declared = opts.req.declared_tools !== undefined
      ? JSON.stringify(opts.req.declared_tools)
      : existing.declared_tools;
    const envs = opts.req.environments !== undefined
      ? JSON.stringify(opts.req.environments)
      : existing.environments;

    this.db.prepare(
      `UPDATE agents SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         owner_email = COALESCE(?, owner_email),
         declared_tools = ?,
         max_cost_daily_usd = CASE WHEN ? THEN ? ELSE max_cost_daily_usd END,
         environments = ?,
         status = COALESCE(?, status),
         public_key_pem = CASE WHEN ? THEN ? ELSE public_key_pem END,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      opts.req.name ?? null,
      opts.req.description ?? null,
      opts.req.owner_email ?? null,
      declared,
      opts.req.max_cost_daily_usd !== undefined ? 1 : 0,
      opts.req.max_cost_daily_usd ?? null,
      envs,
      opts.req.status ?? null,
      opts.req.public_key_pem !== undefined ? 1 : 0,
      opts.req.public_key_pem ?? null,
      opts.agentId,
    );
    return this.get(opts.agentId);
  }

  /** Generates a fresh secret and stores its hash. Returns the plaintext
   *  once; caller is responsible for transporting it to the agent. */
  rotateSecret(opts: { orgId: string; agentId: string }): { secret: string } | null {
    const existing = this.getRow(opts.agentId);
    if (!existing || existing.org_id !== opts.orgId) return null;
    const secret = mintSecret();
    this.db.prepare(
      `UPDATE agents SET secret_hash = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(sha256(secret), opts.agentId);
    return { secret };
  }

  deregister(opts: { orgId: string; agentId: string }): boolean {
    const existing = this.getRow(opts.agentId);
    if (!existing || existing.org_id !== opts.orgId) return false;
    this.db.prepare(
      `UPDATE agents SET status = 'deprecated', updated_at = datetime('now') WHERE id = ?`,
    ).run(opts.agentId);
    return true;
  }

  get(agentId: string): RegisteredAgent | null {
    const row = this.getRow(agentId);
    return row ? rowToAgent(row) : null;
  }

  list(opts: { orgId: string; status?: AgentStatus; includeDeprecated?: boolean }): RegisteredAgent[] {
    const filters = ['org_id = ?'];
    const params: any[] = [opts.orgId];
    if (opts.status) {
      filters.push('status = ?');
      params.push(opts.status);
    } else if (!opts.includeDeprecated) {
      filters.push("status != 'deprecated'");
    }
    const rows = this.db.prepare(
      `SELECT * FROM agents WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC`,
    ).all(...params) as any[];
    return rows.map(rowToAgent);
  }

  private getRow(agentId: string): any {
    return this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId);
  }
}
