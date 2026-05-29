/**
 * Sinks API — runtime view + dry-fire.
 *
 *   GET  /api/v1/sinks                 → list configured sinks + live metrics
 *   POST /api/v1/sinks/test            → dry-fire a synthetic event through
 *                                        every configured sink (no save)
 *
 * Sink configuration itself goes through /api/v1/config (whole tenant
 * config replace) or /api/v1/config/patch (partial). That endpoint is the
 * source of truth; this one just observes the live state.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { SinkOrchestrator } from '../services/sink-orchestrator';
import { TenantConfigService } from '../services/tenant-config';

function orgIdOf(req: Request): string {
  // Same fallback strategy as PolicyDslAPI — single-org community mode.
  return (req as any).orgId ?? 'org-default';
}

export class SinksAPI {
  readonly router: Router;

  constructor(
    private orchestrator: SinkOrchestrator,
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
      const configured = cfg.sinks ?? [];
      const metrics = this.orchestrator.metrics(orgId);
      res.json({
        org_id: orgId,
        configured,
        metrics,
      });
    });

    this.router.post('/test', async (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const sample = req.body?.event ?? {
        kind: 'audit',
        tenantId: orgId,
        timestamp: new Date().toISOString(),
        payload: {
          action: 'sink.test',
          resource_type: 'system',
          message: 'AEGIS sink dry-fire — no real action took place.',
        },
      };
      try {
        const results = await this.orchestrator.fireOne(orgId, sample);
        res.json({ sent_to: results.length, results });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'sink dry-fire failed');
        res.status(500).json({ error: { code: 'DRY_FIRE_FAILED', message: (err as Error).message } });
      }
    });
  }
}
