import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import {
  AgentRegistrationRequestSchema,
  AgentUpdateRequestSchema,
  AgentStatusSchema,
} from '@agentguard/core-schema';
import { AgentRegistryService } from '../services/agent-registry';
import { AuditLogService } from './../services/audit-log';

// agent_id is supplied by SDKs and is typically a UUID, but legacy callers
// may use slug-like identifiers. Accept either, reject anything else so we
// never run a query with arbitrary control chars or 10MB strings.
const AgentIdParamSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}

export class AgentsAPI {
  router: Router;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private registry: AgentRegistryService,
    private audit: AuditLogService,
  ) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes() {
    // Param-level validation — runs before every /:agentId/... handler.
    this.router.param('agentId', (req, res, next, value) => {
      const parsed = AgentIdParamSchema.safeParse(value);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid agentId parameter' });
      }
      next();
    });

    // GET /api/v1/agents/:agentId/anomaly-summary
    this.router.get('/:agentId/anomaly-summary', (req, res) => {
      try {
        const { agentId } = req.params;

        const total = (this.db.prepare(
          `SELECT COUNT(*) as n FROM anomaly_events WHERE agent_id = ?`
        ).get(agentId) as any).n;

        const byDecision = this.db.prepare(`
          SELECT decision, COUNT(*) as count FROM anomaly_events
          WHERE agent_id = ? GROUP BY decision
        `).all(agentId) as { decision: string; count: number }[];

        // Top triggered signal types
        const recentEvents = this.db.prepare(`
          SELECT signals FROM anomaly_events
          WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100
        `).all(agentId) as { signals: string }[];

        const signalCounts: Record<string, { count: number; totalScore: number }> = {};
        for (const row of recentEvents) {
          try {
            const signals = JSON.parse(row.signals) as { type: string; score: number }[];
            for (const s of signals) {
              if (!signalCounts[s.type]) signalCounts[s.type] = { count: 0, totalScore: 0 };
              signalCounts[s.type].count++;
              signalCounts[s.type].totalScore += s.score;
            }
          } catch {}
        }
        const topSignals = Object.entries(signalCounts)
          .map(([type, { count, totalScore }]) => ({ type, count, avg_score: Math.round((totalScore / count) * 100) / 100 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);

        // 7-day trend (events per day)
        const trend7d = this.db.prepare(`
          SELECT date(created_at) as day, COUNT(*) as count
          FROM anomaly_events
          WHERE agent_id = ? AND created_at > datetime('now', '-7 days')
          GROUP BY day ORDER BY day ASC
        `).all(agentId) as { day: string; count: number }[];

        res.json({
          agent_id: agentId,
          total_events: total,
          by_decision: Object.fromEntries(byDecision.map(r => [r.decision, r.count])),
          top_signals: topSignals,
          trend_7d: trend7d,
        });
      } catch (err) {
        this.logger.error({ err }, 'Failed to get anomaly summary');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // GET /api/v1/agents/:agentId/baseline
    this.router.get('/:agentId/baseline', (req, res) => {
      try {
        const { agentId } = req.params;
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Total traces in last 7 days
        const total = (this.db.prepare(
          `SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND timestamp > ?`
        ).get(agentId, since) as any).n as number;

        if (total === 0) {
          return res.json({ agentId, total: 0, top_tools: [], risk_distribution: {}, sessions: 0, pii_rate: 0, block_rate: 0 });
        }

        // Top tools (tool_call field uses 'tool_name' key)
        const top_tools = this.db.prepare(`
          SELECT tool_name, COUNT(*) as count
          FROM (
            SELECT COALESCE(
              json_extract(tool_call, '$.tool_name'),
              json_extract(tool_call, '$.name'),
              json_extract(tool_call, '$.function')
            ) as tool_name
            FROM traces WHERE agent_id = ? AND timestamp > ?
          )
          WHERE tool_name IS NOT NULL
          GROUP BY tool_name ORDER BY count DESC LIMIT 8
        `).all(agentId, since) as { tool_name: string; count: number }[];

        // Risk distribution
        const riskRows = this.db.prepare(`
          SELECT
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'LOW'      THEN 1 ELSE 0 END) as low,
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'MEDIUM'   THEN 1 ELSE 0 END) as medium,
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'HIGH'     THEN 1 ELSE 0 END) as high,
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'CRITICAL' THEN 1 ELSE 0 END) as critical
          FROM traces WHERE agent_id = ? AND timestamp > ?
        `).get(agentId, since) as any;

        // Sessions
        let sessions = 0;
        try {
          sessions = (this.db.prepare(
            `SELECT COUNT(DISTINCT session_id) as n FROM traces WHERE agent_id = ? AND timestamp > ? AND session_id IS NOT NULL`
          ).get(agentId, since) as any).n;
        } catch {}

        // PII rate
        let pii_count = 0;
        try {
          pii_count = (this.db.prepare(
            `SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND timestamp > ? AND pii_detected = 1`
          ).get(agentId, since) as any).n;
        } catch {}

        // Block rate
        let block_count = 0;
        try {
          block_count = (this.db.prepare(
            `SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND timestamp > ? AND blocked = 1`
          ).get(agentId, since) as any).n;
        } catch {}

        res.json({
          agentId,
          total,
          top_tools,
          risk_distribution: {
            LOW:      riskRows?.low      ?? 0,
            MEDIUM:   riskRows?.medium   ?? 0,
            HIGH:     riskRows?.high     ?? 0,
            CRITICAL: riskRows?.critical ?? 0,
          },
          sessions,
          pii_rate:   total > 0 ? Math.round((pii_count   / total) * 100) : 0,
          block_rate: total > 0 ? Math.round((block_count / total) * 100) : 0,
          window_days: 7,
        });
      } catch (err) {
        this.logger.error({ err }, 'Failed to compute agent baseline');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // ── Registry CRUD ────────────────────────────────────────────────────

    // List registered agents. Filter by status; deprecated excluded by
    // default. Query params: ?status=active|suspended|deprecated|unregistered
    // and ?include_deprecated=1.
    this.router.get('/', (req: Request, res: Response) => {
      const status = typeof req.query.status === 'string'
        ? AgentStatusSchema.safeParse(req.query.status)
        : undefined;
      const items = this.registry.list({
        orgId: orgIdOf(req),
        status: status?.success ? status.data : undefined,
        includeDeprecated: req.query.include_deprecated === '1',
      });
      res.json({ items });
    });

    // Register a new agent. Body conforms to AgentRegistrationRequest. If
    // `id` is provided and a row already exists (e.g. unregistered first-
    // sighting record), this PROMOTES it to active in-place.
    this.router.post('/', (req: Request, res: Response) => {
      const parsed = AgentRegistrationRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid registration body', issues: parsed.error.issues });
      }
      const orgId = orgIdOf(req);
      const result = this.registry.register({ orgId, req: parsed.data });
      this.audit.log({
        org_id: orgId,
        action: 'user.create',
        resource_type: 'agent',
        resource_id: result.agent.id,
        details: {
          name: result.agent.name,
          declared_tools_count: result.agent.declared_tools?.length ?? 0,
          issued_secret: !!result.secret,
        },
        ip_address: req.ip,
      });
      res.status(201).json(result);
    });

    // Read a single agent's registry record. Distinct from the analytics
    // endpoints above; this returns the registration metadata.
    this.router.get('/:agentId', (req: Request, res: Response) => {
      // Skip the analytics paths — they have their own handlers above.
      // The `param('agentId')` validator already ran.
      const agent = this.registry.get(req.params.agentId);
      if (!agent || agent.org_id !== orgIdOf(req)) {
        return res.status(404).json({ error: 'agent not found' });
      }
      res.json({ agent });
    });

    this.router.patch('/:agentId', (req: Request, res: Response) => {
      const parsed = AgentUpdateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid update body', issues: parsed.error.issues });
      }
      const orgId = orgIdOf(req);
      const updated = this.registry.update({
        orgId,
        agentId: req.params.agentId,
        req: parsed.data,
      });
      if (!updated) return res.status(404).json({ error: 'agent not found' });
      this.audit.log({
        org_id: orgId,
        action: 'user.update',
        resource_type: 'agent',
        resource_id: updated.id,
        details: { changed_keys: Object.keys(parsed.data) },
        ip_address: req.ip,
      });
      res.json({ agent: updated });
    });

    // Rotate the agent secret. Plaintext is returned ONCE; only its hash
    // is kept. Callers should transport the new secret to the agent
    // out-of-band (env var rotation, secret manager update, etc).
    this.router.post('/:agentId/rotate-secret', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const r = this.registry.rotateSecret({ orgId, agentId: req.params.agentId });
      if (!r) return res.status(404).json({ error: 'agent not found' });
      this.audit.log({
        org_id: orgId,
        action: 'apikey.regenerate',
        resource_type: 'agent',
        resource_id: req.params.agentId,
        ip_address: req.ip,
      });
      res.json(r);
    });

    // Soft delete — status flips to 'deprecated'. Existing audit rows
    // keep the agent_id reference; analytics still query it.
    this.router.delete('/:agentId', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const ok = this.registry.deregister({ orgId, agentId: req.params.agentId });
      if (!ok) return res.status(404).json({ error: 'agent not found' });
      this.audit.log({
        org_id: orgId,
        action: 'user.delete',
        resource_type: 'agent',
        resource_id: req.params.agentId,
        ip_address: req.ip,
      });
      res.status(204).end();
    });
  }
}
