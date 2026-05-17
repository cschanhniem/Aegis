/**
 * Per-tenant config API.
 *
 * All routes operate on the current tenant resolved from auth context
 * (req.orgId, set by middleware/auth.ts). Cross-tenant management lives at
 * /api/v1/admin/orgs/:orgId — that path uses RBACService directly. This API
 * is the self-service surface customers and the Cockpit talk to.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import {
  ApplyTemplateRequestSchema,
  TenantConfigSchema,
} from '@agentguard/core-schema';
import { TenantConfigService } from '../services/tenant-config';
import { TemplateName } from '../policies/templates';

function buildContext(req: Request) {
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

function sendZodError(res: Response, err: z.ZodError) {
  res.status(400).json({
    error: 'Invalid TenantConfig',
    details: err.issues,
  });
}

export class TenantConfigAPI {
  public router: Router;

  constructor(
    private service: TenantConfigService,
    private logger: Logger,
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    // ── Templates (must come before /:something handlers) ──────────────────
    this.router.get('/templates', (_req: Request, res: Response) => {
      try {
        res.json({ templates: this.service.listTemplates() });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.router.get('/templates/:name', (req: Request, res: Response) => {
      try {
        const meta = this.service.getTemplate(
          req.params.name as TemplateName,
        );
        if (!meta) return res.status(404).json({ error: 'Template not found' });
        res.json(meta);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.router.post('/apply-template', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      const parsed = ApplyTemplateRequestSchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const cfg = this.service.applyTemplate(
          orgId,
          parsed.data.template,
          buildContext(req),
        );
        res.json(cfg);
      } catch (e: any) {
        const status = (e?.status as number) ?? 500;
        res.status(status).json({ error: e.message });
      }
    });

    // ── Current tenant config ──────────────────────────────────────────────
    this.router.get('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      try {
        res.json(this.service.get(orgId));
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.router.put('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      const parsed = TenantConfigSchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const cfg = this.service.replace(orgId, parsed.data, buildContext(req));
        res.json(cfg);
      } catch (e: any) {
        const status = (e?.status as number) ?? 500;
        res.status(status).json({ error: e.message });
      }
    });

    this.router.patch('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }
      try {
        const cfg = this.service.update(orgId, req.body, buildContext(req));
        res.json(cfg);
      } catch (e: any) {
        if (e instanceof z.ZodError) return sendZodError(res, e);
        const status = (e?.status as number) ?? 500;
        res.status(status).json({ error: e.message });
      }
    });
  }
}
