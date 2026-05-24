/**
 * Evidence-pack REST endpoint.
 *
 *   GET /api/v1/evidence-pack/export
 *
 * Returns a downloadable JSON file. Honours the requester's orgId
 * (set by the auth middleware) so a multi-tenant deployment can't
 * cross-pull other orgs' audit data. Filename includes the org id
 * and the generation timestamp so auditors can drop multiple packs
 * into one folder without collisions.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import Database from 'better-sqlite3';
import { EvidencePackService } from '../services/evidence-pack';
import { AuditLogService } from '../services/audit-log';
import { auditActor } from '../middleware/auth';

export class EvidencePackAPI {
  public router: Router;
  private svc: EvidencePackService;

  constructor(
    db: Database.Database,
    private logger: Logger,
    private auditLog: AuditLogService,
  ) {
    this.router = Router();
    this.svc = new EvidencePackService(db, logger);

    this.router.get('/export', (req: Request, res: Response) => {
      const orgId = (req as any).orgId ?? 'default';
      try {
        const pack = this.svc.build(orgId);

        // Exporting evidence is itself an auditable action — record it
        // so a chain-of-custody question can be answered later.
        this.auditLog.log({
          org_id: orgId,
          ...auditActor(req),
          action: 'judge.trace',
          resource_type: 'system',
          resource_id: 'evidence-pack',
          details: {
            kind: 'evidence_pack_export',
            audit_rows: pack.audit_log.length,
            agent_count: pack.integrity.total_agents,
            broken_agents: pack.integrity.broken_agents,
          },
          ip_address: req.ip,
        });

        const fname = `aegis-evidence-${orgId}-${pack.meta.generated_at.replace(/[:.]/g, '-')}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.send(JSON.stringify(pack, null, 2));
      } catch (err) {
        this.logger.error({ err, orgId }, 'evidence-pack export failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
