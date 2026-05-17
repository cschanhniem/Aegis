/**
 * Per-tenant Policy DSL CRUD.
 *
 *   GET    /api/v1/dsl                — current tenant's DSL (or null)
 *   PUT    /api/v1/dsl                — replace
 *   DELETE /api/v1/dsl                — remove
 *   POST   /api/v1/dsl/dry-run        — compile + evaluate without persisting
 *   GET    /api/v1/dsl/examples       — list builtin starter docs
 *
 * Persistence flows through TenantConfigService so:
 *   - audit log entries are written via the shared mechanism
 *   - ConfigBus emits an update → DslPolicyService recompiles automatically
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import { PolicyDsl, PolicyDslSchema } from '@agentguard/core-schema';
import { TenantConfigService } from '../services/tenant-config';
import { DslPolicyService } from '../services/policy-dsl';
import { BUILTIN_DSL_EXAMPLES } from '../policies/dsl/builtin-examples';
import { DslCompileError } from '../policies/dsl/ast';
import { DslContext } from '../policies/dsl/evaluator';

const DryRunRequestSchema = z.object({
  dsl: PolicyDslSchema,
  context: z.record(z.unknown()),
});

function ctxFromReq(req: Request) {
  return {
    userEmail: (req as any).userEmail as string | undefined,
    userId: (req as any).userId as string | undefined,
    ipAddress: req.ip,
  };
}

function resolveOrgId(req: Request, res: Response): string | null {
  const orgId = req.orgId;
  if (!orgId) {
    res.status(401).json({ error: 'No tenant context (missing X-API-Key)' });
    return null;
  }
  return orgId;
}

export class PolicyDslAPI {
  public router: Router;

  constructor(
    private tenantConfig: TenantConfigService,
    private dsl: DslPolicyService,
    private logger: Logger,
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.get('/examples', (_req: Request, res: Response) => {
      res.json({ examples: BUILTIN_DSL_EXAMPLES });
    });

    this.router.post('/dry-run', (req: Request, res: Response) => {
      const parsed = DryRunRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid dry-run request',
          details: parsed.error.issues,
        });
      }
      try {
        const result = this.dsl.dryRun(
          parsed.data.dsl,
          parsed.data.context as DslContext,
        );
        res.json({ match: result });
      } catch (err) {
        if (err instanceof DslCompileError) {
          return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.router.get('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      const cfg = this.tenantConfig.get(orgId);
      res.json({ dsl: cfg.dsl ?? null });
    });

    this.router.put('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      const parsed = PolicyDslSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid DSL',
          details: parsed.error.issues,
        });
      }
      // Compile up-front to surface DslCompileError before persisting.
      try {
        this.dsl.dryRun(parsed.data, {});
      } catch (err) {
        if (err instanceof DslCompileError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
      try {
        const updated = this.tenantConfig.update(
          orgId,
          { dsl: parsed.data },
          ctxFromReq(req),
        );
        res.json({ dsl: updated.dsl ?? null });
      } catch (err: any) {
        const status = (err?.status as number) ?? 500;
        res.status(status).json({ error: err.message });
      }
    });

    this.router.delete('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      try {
        // Replace entire config with dsl removed; deep-merge would not
        // delete a field, so we read+rewrite.
        const current = this.tenantConfig.get(orgId);
        const next: PolicyDsl | undefined = undefined;
        const merged = { ...current, dsl: next };
        delete (merged as any).dsl;
        this.tenantConfig.replace(
          orgId,
          merged as any,
          ctxFromReq(req),
        );
        res.status(204).send();
      } catch (err: any) {
        const status = (err?.status as number) ?? 500;
        res.status(status).json({ error: err.message });
      }
    });
  }
}
