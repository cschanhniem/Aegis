/**
 * SCIM 2.0 REST API (RFC 7644).
 *
 *   GET    /scim/v2/Users
 *   POST   /scim/v2/Users
 *   GET    /scim/v2/Users/:id
 *   PUT    /scim/v2/Users/:id
 *   PATCH  /scim/v2/Users/:id
 *   DELETE /scim/v2/Users/:id
 *
 *   GET    /scim/v2/Groups
 *   POST   /scim/v2/Groups
 *   GET    /scim/v2/Groups/:id
 *   PATCH  /scim/v2/Groups/:id
 *   DELETE /scim/v2/Groups/:id
 *
 *   GET    /scim/v2/ServiceProviderConfig    (RFC 7643 §5)
 *   GET    /scim/v2/ResourceTypes            (RFC 7643 §6)
 *   GET    /scim/v2/Schemas                  (RFC 7643 §7)
 *
 * Auth: Bearer token in `Authorization: Bearer scim_...`. The token
 * resolves to an orgId via ScimService.resolveToken. There is no
 * X-API-Key support here — IdPs only know how to send Bearer.
 *
 * Errors follow the SCIM error response shape:
 *   { schemas: [...], status: "<HTTP>", scimType?: <code>, detail }
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { ScimService, ScimError } from '../services/scim-service';

const SCHEMAS_ERROR = ['urn:ietf:params:scim:api:messages:2.0:Error'];

export class ScimAPI {
  router: Router;

  constructor(private svc: ScimService, private logger: Logger) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Discovery endpoints are intentionally public per RFC 7643 §5 — IdPs
    // hit them before authenticating to figure out which features the
    // provider supports. But "public" doesn't mean "unbounded": a
    // scripted reconnaissance loop hitting /Schemas can saturate a small
    // tenant. Apply a soft per-IP token bucket so abusive callers get
    // 429'd before they reach the rest of the surface.
    const discoveryLimiter = this.makeDiscoveryLimiter();
    this.router.get('/ServiceProviderConfig', discoveryLimiter, this.spConfig.bind(this));
    this.router.get('/ResourceTypes',         discoveryLimiter, this.resourceTypes.bind(this));
    this.router.get('/Schemas',               discoveryLimiter, this.schemas.bind(this));

    this.router.use(this.bearerAuth.bind(this));

    this.router.get(   '/Users',           this.listUsers.bind(this));
    this.router.post(  '/Users',           this.createUser.bind(this));
    this.router.get(   '/Users/:id',       this.getUser.bind(this));
    this.router.put(   '/Users/:id',       this.replaceUser.bind(this));
    this.router.patch( '/Users/:id',       this.patchUser.bind(this));
    this.router.delete('/Users/:id',       this.deleteUser.bind(this));

    this.router.get(   '/Groups',          this.listGroups.bind(this));
    this.router.post(  '/Groups',          this.createGroup.bind(this));
    this.router.get(   '/Groups/:id',      this.getGroup.bind(this));
    this.router.patch( '/Groups/:id',      this.patchGroup.bind(this));
    this.router.delete('/Groups/:id',      this.deleteGroup.bind(this));
  }

  // ── Auth ──────────────────────────────────────────────────────────

  private bearerAuth(req: Request, res: Response, next: Function): void {
    const auth = req.header('authorization') ?? '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) { this.error(res, 401, 'invalidCredentials', 'Bearer token required'); return; }
    const orgId = this.svc.resolveToken(m[1].trim());
    if (!orgId) { this.error(res, 401, 'invalidCredentials', 'invalid or revoked SCIM token'); return; }
    (req as any).orgId = orgId;
    next();
  }

  private orgIdOf(req: Request): string { return (req as any).orgId; }

  /** Per-IP token bucket for SCIM discovery endpoints. The bucket is
   *  small (60 / minute, ~1 req/sec) — IdPs hit these < 10 times during
   *  their entire connector setup, so legitimate traffic never even
   *  comes close. The Map is capped at 4096 distinct IPs and evicts
   *  the oldest entry on overflow so a /16 attacker can't OOM us. */
  private makeDiscoveryLimiter() {
    const WINDOW_MS = 60_000;
    const BUDGET    = 60;
    const MAX_IPS   = 4096;
    const buckets   = new Map<string, { count: number; resetAt: number }>();
    return (req: Request, res: Response, next: Function) => {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
              || req.socket.remoteAddress
              || 'unknown';
      const now = Date.now();
      let b = buckets.get(ip);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + WINDOW_MS };
        // LRU-ish: when map fills, drop the entry whose window expired
        // furthest in the past. O(n) but n is bounded at MAX_IPS.
        if (buckets.size >= MAX_IPS) {
          let oldest: string | null = null;
          let oldestResetAt = Infinity;
          for (const [k, v] of buckets) {
            if (v.resetAt < oldestResetAt) { oldestResetAt = v.resetAt; oldest = k; }
          }
          if (oldest) buckets.delete(oldest);
        }
        buckets.set(ip, b);
      }
      b.count++;
      if (b.count > BUDGET) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
        this.error(res, 429, undefined, 'too many discovery requests — slow down');
        return;
      }
      next();
    };
  }

  // ── Discovery (public) ───────────────────────────────────────────

  private spConfig(_req: Request, res: Response): void {
    res.json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch:               { supported: true },
      bulk:                { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter:              { supported: true, maxResults: 200 },
      changePassword:      { supported: false },
      sort:                { supported: false },
      etag:                { supported: false },
      authenticationSchemes: [
        { name: 'OAuth Bearer Token', description: 'Long-lived bearer token issued at IdP setup time.',
          specUri: 'http://www.rfc-editor.org/info/rfc6750',
          documentationUri: 'https://docs.agentguard.example/scim', type: 'oauthbearertoken', primary: true },
      ],
      meta: { resourceType: 'ServiceProviderConfig' },
    });
  }

  private resourceTypes(_req: Request, res: Response): void {
    res.json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      Resources: [
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User', name: 'User', endpoint: '/Users',
          schema: 'urn:ietf:params:scim:schemas:core:2.0:User' },
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group', name: 'Group', endpoint: '/Groups',
          schema: 'urn:ietf:params:scim:schemas:core:2.0:Group' },
      ],
    });
  }

  private schemas(_req: Request, res: Response): void {
    res.json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      Resources: [
        { id: 'urn:ietf:params:scim:schemas:core:2.0:User',  name: 'User',
          attributes: ['id','externalId','userName','name','displayName','emails','active','groups','meta'] },
        { id: 'urn:ietf:params:scim:schemas:core:2.0:Group', name: 'Group',
          attributes: ['id','externalId','displayName','members','meta'] },
      ],
    });
  }

  // ── Users ─────────────────────────────────────────────────────────

  private listUsers(req: Request, res: Response): void {
    this.exec(res, () => this.svc.listUsers(this.orgIdOf(req), {
      filter: typeof req.query.filter === 'string' ? req.query.filter : undefined,
      startIndex: req.query.startIndex ? Number(req.query.startIndex) : undefined,
      count:      req.query.count      ? Number(req.query.count)      : undefined,
      locationBase: this.baseUrl(req),
    }));
  }

  private createUser(req: Request, res: Response): void {
    this.exec(res, () => {
      const u = this.svc.createUser(this.orgIdOf(req), req.body, this.baseUrl(req));
      res.status(201).setHeader('Location', u.meta.location ?? '').json(u);
      return undefined;
    });
  }

  private getUser(req: Request, res: Response): void {
    const u = this.svc.getUser(this.orgIdOf(req), req.params.id, this.baseUrl(req));
    if (!u) return this.error(res, 404, undefined, 'not found');
    res.json(u);
  }

  private replaceUser(req: Request, res: Response): void {
    this.exec(res, () => this.svc.replaceUser(this.orgIdOf(req), req.params.id, req.body, this.baseUrl(req)));
  }

  private patchUser(req: Request, res: Response): void {
    const ops = req.body?.Operations ?? req.body?.operations ?? [];
    this.exec(res, () => this.svc.patchUser(this.orgIdOf(req), req.params.id, ops, this.baseUrl(req)));
  }

  private deleteUser(req: Request, res: Response): void {
    const ok = this.svc.deleteUser(this.orgIdOf(req), req.params.id);
    if (!ok) return this.error(res, 404, undefined, 'not found');
    res.status(204).end();
  }

  // ── Groups ────────────────────────────────────────────────────────

  private listGroups(req: Request, res: Response): void {
    this.exec(res, () => this.svc.listGroups(this.orgIdOf(req), {
      filter: typeof req.query.filter === 'string' ? req.query.filter : undefined,
      startIndex: req.query.startIndex ? Number(req.query.startIndex) : undefined,
      count:      req.query.count      ? Number(req.query.count)      : undefined,
      locationBase: this.baseUrl(req),
    }));
  }

  private createGroup(req: Request, res: Response): void {
    this.exec(res, () => {
      const g = this.svc.createGroup(this.orgIdOf(req), req.body, this.baseUrl(req));
      res.status(201).setHeader('Location', g.meta.location ?? '').json(g);
      return undefined;
    });
  }

  private getGroup(req: Request, res: Response): void {
    const g = this.svc.getGroup(this.orgIdOf(req), req.params.id, this.baseUrl(req));
    if (!g) return this.error(res, 404, undefined, 'not found');
    res.json(g);
  }

  private patchGroup(req: Request, res: Response): void {
    const ops = req.body?.Operations ?? req.body?.operations ?? [];
    this.exec(res, () => this.svc.patchGroup(this.orgIdOf(req), req.params.id, ops, this.baseUrl(req)));
  }

  private deleteGroup(req: Request, res: Response): void {
    const ok = this.svc.deleteGroup(this.orgIdOf(req), req.params.id);
    if (!ok) return this.error(res, 404, undefined, 'not found');
    res.status(204).end();
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /** Run a handler that returns a body (or undefined if already sent).
   *  Catches ScimError → typed response, other errors → 500. */
  private exec(res: Response, fn: () => any): void {
    try {
      const body = fn();
      if (body !== undefined) res.json(body);
    } catch (err: any) {
      if (err instanceof ScimError) return this.error(res, err.status, undefined, err.message);
      this.logger.error({ err: err?.message }, 'SCIM handler crash');
      this.error(res, 500, undefined, 'internal error');
    }
  }

  private error(res: Response, status: number, scimType: string | undefined, detail: string): void {
    res.status(status).json({
      schemas: SCHEMAS_ERROR,
      status: String(status),
      scimType,
      detail,
    });
  }

  private baseUrl(req: Request): string {
    // Best-effort canonical URL the resource can be GETed at. Honours
    // forwarded proto/host so a load-balanced deploy reports the
    // public URL rather than the internal pod address.
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'https';
    const host  = (req.headers['x-forwarded-host']  as string) ?? req.headers.host  ?? 'localhost';
    return `${proto}://${host}${req.baseUrl}`;
  }
}
