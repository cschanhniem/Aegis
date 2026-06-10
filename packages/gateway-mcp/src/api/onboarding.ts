/**
 * OnboardingAPI — endpoints that power the Cockpit first-run wizard.
 *
 * `GET /api/v1/onboarding/stream` is a Server-Sent-Events stream. The
 * Cockpit's onboarding wizard subscribes once the user has copied the
 * snippet and is waiting for their first trace. The stream pushes:
 *
 *   event: ready       — confirms the connection is up
 *   event: heartbeat   — sent every 25s so proxies don't time us out
 *   event: agent.first_sighting
 *     data: { orgId, agentId, timestamp, provenance? }
 *
 * Filtering: subscribers only see events for their own org_id, derived
 * from the auth middleware that already populated req.orgId.
 *
 * `GET /api/v1/onboarding/status` is a one-shot probe so the wizard
 * can decide whether to skip step 3 (e.g. the org already has agents).
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import {
  AgentFirstSightingEvent,
  AgentRegistryService,
} from '../services/agent-registry';

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}

export class OnboardingAPI {
  router: Router;

  constructor(
    private registry: AgentRegistryService,
    private logger: Logger,
  ) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.router.get('/stream', this.stream.bind(this));
    this.router.get('/status', this.status.bind(this));
  }

  private status(req: Request, res: Response): void {
    const orgId = orgIdOf(req);
    const agents = this.registry.list({ orgId, includeDeprecated: false });
    const hasAgents = agents.length > 0;
    const firstSeen = agents
      .map(a => a.last_seen_at)
      .filter((x): x is string => !!x)
      .sort()[0];
    res.json({
      org_id: orgId,
      has_agents: hasAgents,
      agent_count: agents.length,
      first_seen_at: firstSeen,
    });
  }

  private stream(req: Request, res: Response): void {
    const orgId = orgIdOf(req);

    // SSE handshake. flushHeaders so the client sees the open immediately.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        this.logger.debug({ err: (err as Error).message }, 'SSE write failed');
      }
    };

    send('ready', { org_id: orgId, ts: new Date().toISOString() });

    // Snapshot of any agents the org already has — lets the wizard land
    // on the "already onboarded" state without a separate request.
    const existing = this.registry.list({ orgId, includeDeprecated: false });
    if (existing.length > 0) {
      send('snapshot', {
        agents: existing.slice(0, 50).map(a => ({
          id: a.id,
          status: a.status,
          last_seen_at: a.last_seen_at,
        })),
      });
    }

    const unsubscribe = this.registry.onFirstSighting((e: AgentFirstSightingEvent) => {
      if (e.orgId !== orgId) return;
      send('agent.first_sighting', e);
    });

    const heartbeat = setInterval(() => {
      send('heartbeat', { ts: new Date().toISOString() });
    }, 25_000);
    heartbeat.unref?.();   // never block process exit on this timer

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try { res.end(); } catch { /* already closed */ }
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('error', cleanup);
  }
}
