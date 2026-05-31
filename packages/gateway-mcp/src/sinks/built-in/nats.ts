/**
 * NATS sink — for shops that run NATS / JetStream as their event spine
 * (common in fintech and gaming). Mirrors KafkaSink's lazy-require +
 * injectable-factory pattern so the `nats` lib stays an opt-in peer dep.
 */

import {
  NatsSinkConfig,
  Sink,
  SinkEvent,
  SinkSendResult,
} from '@agentguard/core-schema';
import { applyMapping } from '../template';

export type NatsFactory = (cfg: NatsSinkConfig) => {
  publish(subject: string, payload: string): Promise<void> | void;
  close(): Promise<void> | void;
};

let defaultFactory: NatsFactory | null = null;
export function setDefaultNatsFactory(f: NatsFactory | null): void {
  defaultFactory = f;
}

function buildDefaultFactory(): NatsFactory {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let nats: any;
  try { nats = require('nats'); }
  catch (err) {
    throw new Error(
      "nats is not installed. Run `npm install nats` in the gateway " +
      "deployment to enable NATS sinks.",
    );
  }
  return (cfg) => {
    let conn: any;
    let connectPromise: Promise<any> | null = null;
    const ensure = async () => {
      if (conn) return conn;
      if (!connectPromise) {
        const opts: any = { servers: cfg.servers, timeout: cfg.timeoutMs };
        if (cfg.token) opts.token = cfg.token;
        if (cfg.user)  { opts.user = cfg.user; opts.pass = cfg.pass; }
        connectPromise = nats.connect(opts);
      }
      conn = await connectPromise;
      return conn;
    };
    return {
      async publish(subject: string, payload: string) {
        const c = await ensure();
        const enc = nats.StringCodec ? nats.StringCodec().encode(payload) : Buffer.from(payload);
        c.publish(subject, enc);
        if (typeof c.flush === 'function') await c.flush();
      },
      async close() {
        if (conn && typeof conn.drain === 'function') await conn.drain();
        else if (conn && typeof conn.close === 'function') await conn.close();
      },
    };
  };
}

export class NatsSink implements Sink {
  readonly name: string;
  readonly kind = 'nats' as const;
  private client?: ReturnType<NatsFactory>;
  private readonly factory: NatsFactory;

  constructor(private cfg: NatsSinkConfig, factory?: NatsFactory) {
    this.name = cfg.name;
    this.factory = factory ?? defaultFactory ?? buildDefaultFactory();
  }

  async send(event: SinkEvent): Promise<SinkSendResult> {
    const start = Date.now();
    const body = JSON.stringify(applyMapping(event, this.cfg.fieldMapping));

    let lastErr: string | undefined;
    const maxAttempts = this.cfg.retry.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!this.client) this.client = this.factory(this.cfg);
        await this.client.publish(this.cfg.subject, body);
        return { ok: true, attempts: attempt, durationMs: Date.now() - start };
      } catch (err) {
        lastErr = (err as Error).message ?? 'nats publish failed';
      }
      if (attempt < maxAttempts) {
        await sleep(this.cfg.retry.backoffMs * Math.pow(this.cfg.retry.factor, attempt - 1));
      }
    }
    return { ok: false, attempts: maxAttempts, error: lastErr, durationMs: Date.now() - start };
  }

  async close(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* idempotent */ }
      this.client = undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
