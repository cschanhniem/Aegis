/**
 * Observability API — read-only status + manual export trigger.
 *
 *   GET  /api/v1/observability/status   current OTLP exporter state per tenant
 *   POST /api/v1/observability/flush    force one tick (handy for dashboards / tests)
 *
 * Config lives in /api/v1/config (tenant config). This endpoint just
 * observes runtime state.
 */

import { Router, Request, Response } from 'express';
import { OtlpExporterService } from '../services/otlp-exporter';

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'org-default';
}

export class ObservabilityAPI {
  readonly router: Router;

  constructor(private exporter: OtlpExporterService) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/status', (req: Request, res: Response) => {
      res.json(this.exporter.status(orgIdOf(req)));
    });

    this.router.post('/flush', async (req: Request, res: Response) => {
      const result = await this.exporter.tick(orgIdOf(req));
      res.json(result);
    });
  }
}
