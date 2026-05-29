/**
 * SinkRuntime — instantiates Sinks from declarative SinkConfig[], fans every
 * event out across them, and tracks per-sink success/failure metrics.
 *
 * Hot-reloadable: when a tenant's sinks config changes (via ConfigBus), call
 * setConfigs() to rebuild the live sink set. Old sinks' in-flight sends are
 * not interrupted — they finish or time out on their own.
 *
 * Bounded in-memory DLQ (default 1000 events / sink). Persistent DLQ
 * (sink_dlq table) is a v1.1 add when we know which customers need it.
 */

import {
  Sink,
  SinkConfig,
  SinkEvent,
  SinkSendResult,
} from '@agentguard/core-schema';
import { Logger } from 'pino';
import { HttpSink } from './built-in/http';
import { SyslogSink } from './built-in/syslog';
import { StdoutSink } from './built-in/stdout';

const DLQ_CAP = 1000;

export interface SinkMetrics {
  readonly sent: number;
  readonly failed: number;
  readonly retries: number;
  readonly lastError?: string;
}

export interface SinkRuntimeOptions {
  logger?: Logger;
  /** Per-sink DLQ cap. Default 1000 events. */
  dlqCap?: number;
}

export class SinkRuntime {
  private sinks = new Map<string, Sink>();
  private dlq = new Map<string, SinkEvent[]>();
  private metrics = new Map<string, { sent: number; failed: number; retries: number; lastError?: string }>();
  private readonly dlqCap: number;
  private readonly logger?: Logger;

  constructor(opts: SinkRuntimeOptions = {}) {
    this.dlqCap = opts.dlqCap ?? DLQ_CAP;
    this.logger = opts.logger;
  }

  setConfigs(configs: ReadonlyArray<SinkConfig>): void {
    const next = new Map<string, Sink>();
    for (const cfg of configs) {
      if (cfg.enabled === false) continue;
      try {
        next.set(cfg.name, instantiate(cfg));
      } catch (err) {
        this.logger?.warn(
          { sink: cfg.name, err: (err as Error).message },
          'sink instantiation failed — skipped',
        );
      }
    }
    // Drop sinks no longer in config — call close() so they can release
    // any persistent connections / pools we add later.
    for (const [name, sink] of this.sinks) {
      if (!next.has(name)) sink.close?.();
    }
    this.sinks = next;
  }

  /** Fan out one event to every registered sink. Failures land in DLQ; do
   *  NOT throw — sink failures must never break the calling audit/decision
   *  path. */
  async fanout(event: SinkEvent): Promise<ReadonlyArray<{ sink: string; result: SinkSendResult }>> {
    const out: { sink: string; result: SinkSendResult }[] = [];
    for (const [name, sink] of this.sinks) {
      try {
        const result = await sink.send(event);
        this.recordResult(name, result);
        if (!result.ok) this.enqueueDlq(name, event);
        out.push({ sink: name, result });
      } catch (err) {
        const result: SinkSendResult = {
          ok: false,
          attempts: 1,
          error: (err as Error).message,
          durationMs: 0,
        };
        this.recordResult(name, result);
        this.enqueueDlq(name, event);
        out.push({ sink: name, result });
      }
    }
    return out;
  }

  list(): ReadonlyArray<{ name: string; kind: string }> {
    return [...this.sinks.values()].map(s => ({ name: s.name, kind: s.kind }));
  }

  getMetrics(name: string): SinkMetrics | undefined {
    return this.metrics.get(name);
  }

  dlqDepth(name: string): number {
    return this.dlq.get(name)?.length ?? 0;
  }

  async shutdown(): Promise<void> {
    for (const s of this.sinks.values()) await s.close?.();
    this.sinks.clear();
  }

  private recordResult(name: string, r: SinkSendResult): void {
    const m = this.metrics.get(name) ?? { sent: 0, failed: 0, retries: 0 };
    if (r.ok) m.sent += 1;
    else { m.failed += 1; m.lastError = r.error; }
    m.retries += Math.max(0, r.attempts - 1);
    this.metrics.set(name, m);
  }

  private enqueueDlq(name: string, event: SinkEvent): void {
    const q = this.dlq.get(name) ?? [];
    q.push(event);
    while (q.length > this.dlqCap) q.shift();   // drop oldest
    this.dlq.set(name, q);
  }
}

function instantiate(cfg: SinkConfig): Sink {
  switch (cfg.kind) {
    case 'http':   return new HttpSink(cfg);
    case 'syslog': return new SyslogSink(cfg);
    case 'stdout': return new StdoutSink(cfg);
  }
}
