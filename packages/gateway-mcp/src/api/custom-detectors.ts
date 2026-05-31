/**
 * Custom-detector REST API.
 *
 *   GET    /api/v1/custom-detectors                list operator's specs
 *   PUT    /api/v1/custom-detectors                replace entire list
 *   POST   /api/v1/custom-detectors                add one (deduplicated by name)
 *   DELETE /api/v1/custom-detectors/:name          remove one
 *   POST   /api/v1/custom-detectors/dry-run        compile + evaluate without persisting
 *
 * Storage is tenant_config.customDetectors[]. Hot-reload via ConfigBus —
 * customer's next request sees the new detector live, no restart.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import {
  CustomDetectorSpec,
  CustomDetectorSpecSchema,
} from '@agentguard/core-schema';
import { TenantConfigService } from '../services/tenant-config';
import { DeclarativeDetector } from '../detectors/declarative-detector';

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}

export class CustomDetectorAPI {
  readonly router: Router;

  constructor(
    private tenantConfig: TenantConfigService,
    private logger: Logger,
  ) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const cfg = this.tenantConfig.get(orgId);
      res.json({ items: cfg.customDetectors ?? [] });
    });

    this.router.put('/', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const body = req.body;
      if (!Array.isArray(body)) {
        return res.status(400).json({ error: 'expected JSON array of CustomDetectorSpec' });
      }
      const parsed = body.map((s, i) => {
        const r = CustomDetectorSpecSchema.safeParse(s);
        return r.success ? { ok: true as const, spec: r.data } : { ok: false as const, index: i, issues: r.error.issues };
      });
      const errs = parsed.filter(p => !p.ok) as Array<{ ok: false; index: number; issues: unknown }>;
      if (errs.length > 0) return res.status(400).json({ error: 'invalid specs', errors: errs });

      const specs: CustomDetectorSpec[] = parsed.map(p => (p as any).spec);
      const dupes = findDuplicates(specs.map(s => s.name));
      if (dupes.length) return res.status(400).json({ error: 'duplicate detector names', names: dupes });

      this.tenantConfig.update(orgId, { customDetectors: specs }, { userEmail: 'api' });
      res.json({ items: specs });
    });

    this.router.post('/', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const parsed = CustomDetectorSpecSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid spec', issues: parsed.error.issues });
      const cfg = this.tenantConfig.get(orgId);
      const existing = cfg.customDetectors ?? [];
      const next = existing.filter(d => d.name !== parsed.data.name).concat(parsed.data);
      this.tenantConfig.update(orgId, { customDetectors: next }, { userEmail: 'api' });
      res.status(201).json({ spec: parsed.data });
    });

    this.router.delete('/:name', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const cfg = this.tenantConfig.get(orgId);
      const next = (cfg.customDetectors ?? []).filter(d => d.name !== req.params.name);
      this.tenantConfig.update(orgId, { customDetectors: next }, { userEmail: 'api' });
      res.status(204).end();
    });

    this.router.post('/dry-run', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const specResult = CustomDetectorSpecSchema.safeParse(req.body?.spec);
      if (!specResult.success) return res.status(400).json({ error: 'invalid spec', issues: specResult.error.issues });
      const ctx = req.body?.context;
      if (!ctx || typeof ctx !== 'object' || !ctx.tool || !ctx.agent || !ctx.tenant) {
        return res.status(400).json({ error: 'context must include {tool, agent, tenant}' });
      }
      try {
        const det = new DeclarativeDetector(orgId, specResult.data);
        const signals = det.evaluate({
          ...ctx,
          tenant: { id: orgId },   // force-override so dry-run can't escape tenant
        });
        res.json({ signals });
      } catch (err) {
        res.status(400).json({ error: 'detector compile failed', message: (err as Error).message });
      }
    });
  }
}

function findDuplicates<T>(arr: ReadonlyArray<T>): T[] {
  const seen = new Set<T>(); const dup = new Set<T>();
  for (const x of arr) { if (seen.has(x)) dup.add(x); else seen.add(x); }
  return [...dup];
}
