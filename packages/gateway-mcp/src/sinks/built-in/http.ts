/**
 * Universal HTTP sink — covers Splunk HEC, Datadog Logs, Sumo Logic, generic
 * webhooks, Loki, Elasticsearch, anything else that takes JSON over HTTPS.
 *
 * Per-attempt timeout via AbortController; bounded exponential backoff;
 * one Sink instance is reusable across many send() calls.
 */

import {
  HttpSinkConfig,
  Sink,
  SinkEvent,
  SinkSendResult,
} from '@agentguard/core-schema';
import { applyMapping } from '../template';

export class HttpSink implements Sink {
  readonly name: string;
  readonly kind = 'http' as const;

  constructor(private cfg: HttpSinkConfig) {
    this.name = cfg.name;
  }

  async send(event: SinkEvent): Promise<SinkSendResult> {
    const start = Date.now();
    const body = JSON.stringify(applyMapping(event, this.cfg.fieldMapping));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'aegis-sink/1.0',
      ...this.cfg.headers,
    };
    if (this.cfg.authHeader) headers['authorization'] = this.cfg.authHeader;

    let lastErr: string | undefined;
    let lastStatus: number | undefined;
    const maxAttempts = this.cfg.retry.maxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(this.cfg.url, {
          method: this.cfg.method,
          headers,
          body,
          signal: ac.signal,
        });
        clearTimeout(timer);
        lastStatus = res.status;
        if (res.status >= 200 && res.status < 300) {
          return {
            ok: true,
            attempts: attempt,
            status: res.status,
            durationMs: Date.now() - start,
          };
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          // 4xx (except 408/429) is a client mistake — retrying won't help.
          return {
            ok: false,
            attempts: attempt,
            status: res.status,
            error: `non-retryable ${res.status}`,
            durationMs: Date.now() - start,
          };
        }
        lastErr = `http ${res.status}`;
      } catch (err) {
        clearTimeout(timer);
        lastErr = (err as Error).message ?? 'fetch failed';
      }
      if (attempt < maxAttempts) {
        await sleep(this.cfg.retry.backoffMs * Math.pow(this.cfg.retry.factor, attempt - 1));
      }
    }

    return {
      ok: false,
      attempts: maxAttempts,
      status: lastStatus,
      error: lastErr ?? 'unknown',
      durationMs: Date.now() - start,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
