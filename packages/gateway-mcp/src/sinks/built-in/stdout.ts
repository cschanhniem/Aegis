/**
 * Stdout sink — debug / dev only. Writes the mapped event as one JSON line
 * to process.stdout. Useful for confirming a tenant's field mapping is
 * shaped right before pointing it at production SIEM.
 */

import {
  StdoutSinkConfig,
  Sink,
  SinkEvent,
  SinkSendResult,
} from '@agentguard/core-schema';
import { applyMapping } from '../template';

export class StdoutSink implements Sink {
  readonly name: string;
  readonly kind = 'stdout' as const;

  constructor(private cfg: StdoutSinkConfig) {
    this.name = cfg.name;
  }

  async send(event: SinkEvent): Promise<SinkSendResult> {
    const start = Date.now();
    const mapped = applyMapping(event, this.cfg.fieldMapping);
    process.stdout.write(JSON.stringify({ sink: this.name, ...mapped }) + '\n');
    return { ok: true, attempts: 1, durationMs: Date.now() - start };
  }
}
