/**
 * Kafka sink — covers the long tail of enterprise data platforms that
 * standardize on Kafka for security event streaming (Splunk SmartStore via
 * Kafka, Snowflake via Snowpipe Streaming, custom data lakes).
 *
 * `kafkajs` is a peer dependency — not pulled in by default. Operators who
 * configure a Kafka sink install kafkajs themselves, the same way they
 * install AEGIS Docker / npm. If not present, instantiation throws with a
 * clear install hint and the sink registry skips the entry.
 *
 * Producer is cached per Sink instance and reused across calls; close()
 * disconnects it cleanly on tenant config update or shutdown.
 */

import {
  KafkaSinkConfig,
  Sink,
  SinkEvent,
  SinkSendResult,
} from '@agentguard/core-schema';
import { applyMapping } from '../template';

/** Factory hook — tests inject a fake producer; production passes the
 *  result of require('kafkajs').Kafka. */
export type KafkaFactory = (cfg: KafkaSinkConfig) => {
  send(message: { topic: string; messages: Array<{ key?: string; value: string }> }): Promise<unknown>;
  disconnect(): Promise<void>;
};

let defaultFactory: KafkaFactory | null = null;
export function setDefaultKafkaFactory(f: KafkaFactory | null): void {
  defaultFactory = f;
}

function buildDefaultFactory(): KafkaFactory {
  // Lazy require so kafkajs is only loaded when a Kafka sink is actually
  // configured — opt-in peer dep.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let kafkajs: any;
  try { kafkajs = require('kafkajs'); }
  catch (err) {
    throw new Error(
      "kafkajs is not installed. Run `npm install kafkajs` in the gateway " +
      "deployment to enable Kafka sinks.",
    );
  }
  return (cfg) => {
    const kafka = new kafkajs.Kafka({
      clientId: cfg.clientId,
      brokers: cfg.brokers,
      ssl: cfg.ssl,
      sasl: cfg.sasl,
      requestTimeout: cfg.timeoutMs,
    });
    const producer = kafka.producer();
    let connected = false;
    return {
      async send(msg) {
        if (!connected) { await producer.connect(); connected = true; }
        await producer.send(msg);
      },
      async disconnect() {
        if (connected) await producer.disconnect();
      },
    };
  };
}

function dottedGet(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: any = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

export class KafkaSink implements Sink {
  readonly name: string;
  readonly kind = 'kafka' as const;
  private producer?: ReturnType<KafkaFactory>;
  private readonly factory: KafkaFactory;

  constructor(private cfg: KafkaSinkConfig, factory?: KafkaFactory) {
    this.name = cfg.name;
    this.factory = factory ?? defaultFactory ?? buildDefaultFactory();
  }

  async send(event: SinkEvent): Promise<SinkSendResult> {
    const start = Date.now();
    const body = JSON.stringify(applyMapping(event, this.cfg.fieldMapping));
    const keyValue = this.cfg.keyPath ? dottedGet({ event }, this.cfg.keyPath) : undefined;
    const key = keyValue != null ? String(keyValue) : undefined;

    let lastErr: string | undefined;
    const maxAttempts = this.cfg.retry.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!this.producer) this.producer = this.factory(this.cfg);
        await this.producer.send({ topic: this.cfg.topic, messages: [{ key, value: body }] });
        return { ok: true, attempts: attempt, durationMs: Date.now() - start };
      } catch (err) {
        lastErr = (err as Error).message ?? 'kafka send failed';
      }
      if (attempt < maxAttempts) {
        await sleep(this.cfg.retry.backoffMs * Math.pow(this.cfg.retry.factor, attempt - 1));
      }
    }
    return { ok: false, attempts: maxAttempts, error: lastErr, durationMs: Date.now() - start };
  }

  async close(): Promise<void> {
    if (this.producer) {
      try { await this.producer.disconnect(); } catch { /* idempotent */ }
      this.producer = undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
