/**
 * Audit-chain integrity REST endpoint.
 *
 *   GET /api/v1/integrity/verify?agent_id=<id>
 *
 * Returns IntegrityReport. The same surface a CLI command or
 * Cockpit "Verify chain" button hits. Behind requireAuth because
 * the result includes trace_ids — same tenancy scoping as /traces.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import Database from 'better-sqlite3';
import { IntegrityService } from '../services/integrity';

export class IntegrityAPI {
  public router: Router;
  private svc: IntegrityService;

  constructor(db: Database.Database, private logger: Logger) {
    this.router = Router();
    this.svc = new IntegrityService(db, logger);

    this.router.get('/verify', (req: Request, res: Response) => {
      const agentId = (req.query.agent_id as string | undefined)?.trim();
      if (!agentId) {
        return res.status(400).json({ error: 'agent_id query parameter is required' });
      }
      try {
        const report = this.svc.verifyAgentChain(agentId);
        res.json(report);
      } catch (err) {
        this.logger.error({ err, agent_id: agentId }, 'integrity verification failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
