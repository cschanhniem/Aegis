/**
 * Compliance bundle REST API.
 *
 *   GET  /api/v1/compliance/frameworks         list supported frameworks
 *   GET  /api/v1/compliance/controls/:fw       list framework's controls
 *   POST /api/v1/compliance/bundle/:fw         generate a signed bundle
 *                                              (appends to transparency log
 *                                              + writes an audit row)
 *
 * The bundle response IS the artifact — it's the file customers hand to
 * the auditor. Includes bundle_hash + signature + transparency log
 * inclusion entry so the auditor can verify offline.
 */

import { Router, Request, Response } from 'express';
import { Framework, controlsFor, listFrameworks } from '../services/compliance-controls';
import { ComplianceBundleService } from '../services/compliance-bundle';
import { AuditLogService } from '../services/audit-log';

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}

const KNOWN: ReadonlyArray<Framework> = listFrameworks();

function isFramework(v: any): v is Framework {
  return KNOWN.includes(v);
}

export class ComplianceAPI {
  readonly router: Router;

  constructor(
    private bundles: ComplianceBundleService,
    private audit: AuditLogService,
  ) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/frameworks', (_req: Request, res: Response) => {
      res.json({
        frameworks: KNOWN.map(id => ({
          id,
          control_count: controlsFor(id).length,
        })),
      });
    });

    this.router.get('/controls/:framework', (req: Request, res: Response) => {
      const fw = req.params.framework;
      if (!isFramework(fw)) return res.status(404).json({ error: 'unknown framework' });
      res.json({ framework: fw, controls: controlsFor(fw) });
    });

    this.router.post('/bundle/:framework', (req: Request, res: Response) => {
      const fw = req.params.framework;
      if (!isFramework(fw)) return res.status(404).json({ error: 'unknown framework' });
      const orgId = orgIdOf(req);
      const bundle = this.bundles.generate({ framework: fw, orgId });
      this.audit.log({
        org_id: orgId,
        action: 'data.export',
        resource_type: 'system',
        resource_id: `compliance-bundle:${fw}`,
        ip_address: req.ip,
        details: {
          framework: fw,
          bundle_hash: bundle.bundle_hash,
          controls: bundle.summary,
          transparency_log_index: bundle.transparency_log_entry?.index,
        },
      });
      res.json(bundle);
    });
  }
}
