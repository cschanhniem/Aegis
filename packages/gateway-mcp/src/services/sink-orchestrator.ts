/**
 * SinkOrchestrator — joins the per-tenant SinkConfig[] (from TenantConfigService)
 * to a SinkRuntime, and subscribes to AuditLogService so every audit row is
 * fanned out to the right sinks.
 *
 * v1 design choice — single-runtime fan-out across all tenants. Each
 * outgoing event carries `tenantId`, and the runtime ships every event to
 * every sink registered for that tenant. Multi-runtime sharding (per-tenant
 * worker pools) becomes interesting at >100 tenants — at that scale we'll
 * already know the bottleneck shape.
 */

import { Logger } from 'pino';
import {
  SinkConfig,
  SinkEvent,
} from '@agentguard/core-schema';
import { SinkRuntime } from '../sinks/runtime';
import { AuditLogService } from './audit-log';
import { TenantConfigService } from './tenant-config';
import { ConfigBus } from './config-bus';

export class SinkOrchestrator {
  private runtimes = new Map<string, SinkRuntime>();
  private unsubscribeAudit?: () => void;
  private unsubscribeBus?: () => void;

  constructor(
    private logger: Logger,
    private audit: AuditLogService,
    private tenantConfig: TenantConfigService,
    private configBus: ConfigBus,
  ) {}

  /** Build a SinkRuntime per known org from current tenant configs. */
  start(orgIds: ReadonlyArray<string>): void {
    for (const orgId of orgIds) {
      this.reload(orgId);
    }

    // React to tenant_config updates — replace that org's runtime config.
    this.unsubscribeBus = this.configBus.onConfigChange(evt => {
      if (evt.type === 'tenant.config.updated' && evt.orgId) {
        this.reload(evt.orgId);
      }
    });

    // Fan every audit row out to the corresponding org's sinks.
    this.unsubscribeAudit = this.audit.subscribe(entry => {
      const orgId = entry.org_id;
      if (!orgId) return;
      const rt = this.runtimes.get(orgId);
      if (!rt) return;
      const event: SinkEvent = {
        kind: 'audit',
        tenantId: orgId,
        timestamp: entry.timestamp,
        payload: {
          action: entry.action,
          resource_type: entry.resource_type,
          resource_id: entry.resource_id,
          user_email: entry.user_email,
          user_id: entry.user_id,
          ip_address: entry.ip_address,
          details: entry.details,
        },
      };
      // Fire-and-forget; runtime swallows errors. Audit write already
      // happened, sink failure must never propagate back.
      rt.fanout(event).catch(err =>
        this.logger.warn({ err: (err as Error).message, orgId }, 'sink fanout error'),
      );
    });
  }

  /** Replace the runtime config for one org from its current tenant config. */
  reload(orgId: string): void {
    const cfg = this.tenantConfig.get(orgId);
    const sinks: ReadonlyArray<SinkConfig> = cfg.sinks ?? [];
    let rt = this.runtimes.get(orgId);
    if (!rt) {
      rt = new SinkRuntime({ logger: this.logger });
      this.runtimes.set(orgId, rt);
    }
    rt.setConfigs(sinks);
  }

  /** Manual fan-out (used by /sinks/test endpoint to dry-fire). */
  async fireOne(orgId: string, event: SinkEvent): Promise<ReadonlyArray<{ sink: string; ok: boolean; error?: string; attempts: number; durationMs: number }>> {
    const rt = this.runtimes.get(orgId);
    if (!rt) return [];
    const results = await rt.fanout(event);
    return results.map(r => ({
      sink: r.sink,
      ok: r.result.ok,
      error: r.result.error,
      attempts: r.result.attempts,
      durationMs: r.result.durationMs,
    }));
  }

  metrics(orgId: string): ReadonlyArray<{ name: string; kind: string; sent: number; failed: number; retries: number; dlqDepth: number; lastError?: string }> {
    const rt = this.runtimes.get(orgId);
    if (!rt) return [];
    return rt.list().map(({ name, kind }) => {
      const m = rt.getMetrics(name);
      return {
        name,
        kind,
        sent: m?.sent ?? 0,
        failed: m?.failed ?? 0,
        retries: m?.retries ?? 0,
        dlqDepth: rt.dlqDepth(name),
        lastError: m?.lastError,
      };
    });
  }

  async stop(): Promise<void> {
    this.unsubscribeAudit?.();
    this.unsubscribeBus?.();
    for (const rt of this.runtimes.values()) await rt.shutdown();
    this.runtimes.clear();
  }
}
