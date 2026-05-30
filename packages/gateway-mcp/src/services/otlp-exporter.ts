/**
 * OtlpExporterService — polls the traces table per tenant, batches new
 * rows into OTLP JSON, and POSTs to the customer's configured endpoint.
 *
 * Cursor: per-org last_exported_trace_id in gateway_config, key
 *   `otlp_cursor:<org_id>`. Survives restarts; never double-exports.
 *
 * Failure handling: on transport / non-2xx, the cursor is NOT advanced,
 * so the same batch retries on the next tick. Persistent failures don't
 * block AEGIS itself — the trace write path is fully decoupled from
 * export.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { TenantConfigService } from './tenant-config';
import { ConfigBus } from './config-bus';
import { AegisTraceRow, buildExportRequest } from './otlp-convert';

interface OtlpJobState {
  orgId: string;
  timer: NodeJS.Timeout | null;
  /** Last attempted batch; for status endpoint diagnostics. */
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  exportedTotal: number;
}

export class OtlpExporterService {
  private jobs = new Map<string, OtlpJobState>();
  private unsubscribeBus?: () => void;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private tenantConfig: TenantConfigService,
    private configBus: ConfigBus,
  ) {}

  start(orgIds: ReadonlyArray<string>): void {
    for (const orgId of orgIds) this.reload(orgId);
    this.unsubscribeBus = this.configBus.onConfigChange(evt => {
      if (evt.type === 'tenant.config.updated' && evt.orgId) this.reload(evt.orgId);
    });
  }

  private reload(orgId: string): void {
    const cfg = this.tenantConfig.get(orgId).observability?.otlp;
    const job = this.jobs.get(orgId);

    // Disable / not configured → stop any running timer.
    if (!cfg || !cfg.enabled) {
      if (job?.timer) clearInterval(job.timer);
      if (job) job.timer = null;
      return;
    }

    // Restart timer with current interval.
    const next: OtlpJobState = job ?? { orgId, timer: null, exportedTotal: 0 };
    if (next.timer) clearInterval(next.timer);
    next.timer = setInterval(
      () => this.tick(orgId).catch(err =>
        this.logger.warn({ err: (err as Error).message, orgId }, 'OTLP tick failed'),
      ),
      cfg.intervalSec * 1000,
    );
    this.jobs.set(orgId, next);
  }

  /** One poll → convert → POST → advance cursor. */
  async tick(orgId: string): Promise<{ exported: number; ok: boolean; error?: string }> {
    const cfg = this.tenantConfig.get(orgId).observability?.otlp;
    if (!cfg || !cfg.enabled) return { exported: 0, ok: true };
    const job = this.jobs.get(orgId);
    if (job) job.lastAttemptAt = new Date().toISOString();

    const cursor = this.getCursor(orgId);
    const rows = this.db.prepare(
      `SELECT id, trace_id, parent_trace_id, agent_id, timestamp, sequence_number,
              tool_call, observation, safety_validation,
              model, input_tokens, output_tokens, cost_usd, session_id, pii_detected,
              environment
       FROM traces
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
    ).all(cursor, cfg.batchSize) as Array<AegisTraceRow & { id: number }>;

    if (rows.length === 0) return { exported: 0, ok: true };

    const payload = buildExportRequest(rows, {
      serviceName: cfg.serviceName,
      tenantId: orgId,
    });

    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...cfg.headers,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = `OTLP endpoint returned ${res.status}`;
        if (job) { job.lastErrorAt = new Date().toISOString(); job.lastError = err; }
        return { exported: 0, ok: false, error: err };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (job) { job.lastErrorAt = new Date().toISOString(); job.lastError = msg; }
      return { exported: 0, ok: false, error: msg };
    }

    const newCursor = rows[rows.length - 1].id;
    this.setCursor(orgId, newCursor);
    if (job) {
      job.lastSuccessAt = new Date().toISOString();
      job.lastError = undefined;
      job.exportedTotal += rows.length;
    }
    return { exported: rows.length, ok: true };
  }

  status(orgId: string): {
    enabled: boolean;
    endpoint?: string;
    cursor: number;
    exportedTotal: number;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    lastErrorAt?: string;
    lastError?: string;
  } {
    const cfg = this.tenantConfig.get(orgId).observability?.otlp;
    const job = this.jobs.get(orgId);
    return {
      enabled: !!cfg?.enabled,
      endpoint: cfg?.endpoint,
      cursor: this.getCursor(orgId),
      exportedTotal: job?.exportedTotal ?? 0,
      lastAttemptAt: job?.lastAttemptAt,
      lastSuccessAt: job?.lastSuccessAt,
      lastErrorAt: job?.lastErrorAt,
      lastError: job?.lastError,
    };
  }

  stop(): void {
    this.unsubscribeBus?.();
    for (const j of this.jobs.values()) if (j.timer) clearInterval(j.timer);
    this.jobs.clear();
  }

  private getCursor(orgId: string): number {
    try {
      const row = this.db.prepare(
        `SELECT value FROM gateway_config WHERE key = ?`,
      ).get(`otlp_cursor:${orgId}`) as { value: string } | undefined;
      return row ? Number(row.value) : 0;
    } catch {
      return 0;
    }
  }

  private setCursor(orgId: string, cursor: number): void {
    try {
      this.db.prepare(
        `INSERT INTO gateway_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`otlp_cursor:${orgId}`, String(cursor));
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, orgId }, 'OTLP cursor write failed');
    }
  }
}
