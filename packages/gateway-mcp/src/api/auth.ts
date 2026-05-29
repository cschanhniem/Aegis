/**
 * SSO REST API.
 *
 *   GET  /api/v1/auth/login-url   — return the IdP redirect URL + state
 *   POST /api/v1/auth/callback     — exchange code → issue session
 *   GET  /api/v1/auth/me           — current user from Bearer token
 *   POST /api/v1/auth/logout       — revoke the current session
 *
 * /login-url + /callback are intentionally open routes (no API key
 * required) — the entire point is bootstrapping a session for someone
 * who doesn't yet have one. /me + /logout require the Bearer token.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { IdpAdapter, IdpUser } from '../services/idp-adapter';
import { SessionService } from '../services/session';
import { LoginStateStore } from '../services/login-state';
import { AuditLogService } from '../services/audit-log';

const LoginUrlQuerySchema = z.object({
  redirect_uri: z.string().url().max(2048),
  return_to: z.string().max(2048).optional(),
});

const CallbackSchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(256),
  redirect_uri: z.string().url().max(2048),
});

export class AuthAPI {
  public router: Router;
  private stateStore = new LoginStateStore();

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private idp: IdpAdapter,
    private sessions: SessionService,
    private auditLog: AuditLogService,
    private orgId: string = 'default',
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.get('/login-url', (req: Request, res: Response) => {
      const parsed = LoginUrlQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid query', details: parsed.error.issues });
      }
      const state = this.stateStore.issue({ return_to: parsed.data.return_to });
      const url = this.idp.redirectUrl({ state, redirect_uri: parsed.data.redirect_uri });
      res.json({ url, state, provider: this.idp.name });
    });

    this.router.post('/callback', async (req: Request, res: Response) => {
      const parsed = CallbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
      }
      const pending = this.stateStore.consume(parsed.data.state);
      if (!pending) {
        return res.status(400).json({ error: { code: 'STATE_INVALID', message: 'state unknown or expired' } });
      }
      let idpUser: IdpUser;
      try {
        idpUser = await this.idp.exchangeCode({
          code: parsed.data.code,
          state: parsed.data.state,
          expected_state: pending.state,
          redirect_uri: parsed.data.redirect_uri,
        });
      } catch (err) {
        this.logger.warn({ err }, 'idp exchange failed');
        return res.status(401).json({ error: { code: 'IDP_EXCHANGE_FAILED', message: (err as Error).message } });
      }

      // Upsert the user. Email + org is the natural key — we don't try
      // to merge across providers, that would be a separate operation.
      let userRow = this.db.prepare(
        `SELECT id, status FROM users WHERE org_id = ? AND email = ?`,
      ).get(this.orgId, idpUser.email) as { id: string; status: string } | undefined;

      if (!userRow) {
        const newId = `u_${randomBytes(8).toString('hex')}`;
        // First-touch role defaults to 'viewer'; the IdP's role_hint
        // is recorded in audit log but doesn't grant elevation.
        // An admin must promote via the existing user-management route.
        this.db.prepare(
          `INSERT INTO users (id, org_id, email, name, role, status, last_login)
           VALUES (?, ?, ?, ?, 'viewer', 'active', datetime('now'))`,
        ).run(newId, this.orgId, idpUser.email, idpUser.name ?? null);
        userRow = { id: newId, status: 'active' };
        this.auditLog.log({
          org_id: this.orgId,
          user_email: idpUser.email,
          action: 'user.create',
          resource_type: 'user',
          resource_id: newId,
          details: {
            via: 'sso',
            provider: idpUser.provider,
            role_hint: idpUser.role_hint ?? null,
          },
          ip_address: req.ip,
        });
      } else {
        if (userRow.status !== 'active') {
          return res.status(403).json({
            error: { code: 'USER_DISABLED', message: 'user account is disabled' },
          });
        }
        this.db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(userRow.id);
      }

      const session = this.sessions.issue({
        user_id: userRow.id,
        idp: idpUser.provider,
        idp_sub: idpUser.sub,
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
      });

      this.auditLog.log({
        org_id: this.orgId,
        user_email: idpUser.email,
        action: 'user.invite',  // closest enum value for "login via SSO"
        resource_type: 'user',
        resource_id: userRow.id,
        details: {
          kind: 'sso_login',
          provider: idpUser.provider,
          session_id: session.id,
        },
        ip_address: req.ip,
      });

      res.json({
        token: session.token,
        expires_at: session.expires_at,
        user: {
          id: userRow.id,
          email: idpUser.email,
          name: idpUser.name,
          provider: idpUser.provider,
        },
        return_to: pending.return_to ?? null,
      });
    });

    this.router.get('/me', (req: Request, res: Response) => {
      const token = extractBearer(req);
      if (!token) return res.status(401).json({ error: { code: 'NO_SESSION' } });
      const user = this.sessions.resolve(token);
      if (!user) return res.status(401).json({ error: { code: 'SESSION_INVALID' } });
      res.json({ user });
    });

    this.router.post('/logout', (req: Request, res: Response) => {
      // Same lookup as /me but we revoke the session id we find.
      const token = extractBearer(req);
      if (!token) return res.status(204).end();  // idempotent
      const row = this.db.prepare(
        `SELECT id FROM user_sessions WHERE token_hash = ?`,
      ).get(sha256(token)) as { id: string } | undefined;
      if (row) this.sessions.revoke(row.id);
      res.status(204).end();
    });
  }
}

export function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, value] = h.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value;
}

function sha256(s: string): string {
  // Local import to avoid pulling crypto into every consumer just for
  // the one logout-side hash.
  return require('crypto').createHash('sha256').update(s).digest('hex');
}
