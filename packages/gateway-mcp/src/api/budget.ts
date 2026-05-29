/**
 * Budget REST API — read-only view of current spend vs configured limits.
 * Budget CONFIGURATION goes through /api/v1/config (tenant-config) —
 * customers PATCH `{ budget: { … } }` there. This endpoint just shows
 * the live status.
 *
 *   GET /api/v1/budget/status                 → tenant-level status
 *   GET /api/v1/budget/status?agent_id=X      → narrow to one agent
 *   GET /api/v1/budget/status?session_id=Y    → narrow to one session
 */

import { Router, Request, Response } from 'express';
import { BudgetGuardService } from '../services/budget-guard';

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'org-default';
}

export class BudgetAPI {
  readonly router: Router;

  constructor(private guard: BudgetGuardService) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/status', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const status = this.guard.status({
        orgId,
        agentId: typeof req.query.agent_id === 'string' ? req.query.agent_id : undefined,
        sessionId: typeof req.query.session_id === 'string' ? req.query.session_id : undefined,
      });
      res.json(status);
    });
  }
}
