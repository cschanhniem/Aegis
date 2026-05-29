/**
 * DetectorRegistry — collects all registered Detector instances and runs
 * them against a single DetectorContext, emitting an aggregated Signal[].
 *
 * Built-in detectors (PII, classifier, anomaly) register at server boot;
 * tenant-supplied or third-party detectors register through the same
 * `register()` method. The registry runs detectors in registration order
 * grouped by kind: classify → content → behavior → meta, so meta detectors
 * can observe upstream signals.
 */

import { Detector, DetectorContext, DetectorKind, Signal } from '@agentguard/core-schema';
import { Logger } from 'pino';

const KIND_ORDER: DetectorKind[] = ['classify', 'content', 'behavior', 'meta'];

export interface DetectorRegistryOptions {
  /** Hard cap on evaluate() wall-clock per detector, in ms. Detectors that
   *  exceed it are aborted; their absence is logged but does NOT fail the
   *  check — DoS isolation. Default 200ms. */
  perDetectorTimeoutMs?: number;
  logger?: Logger;
}

export class DetectorRegistry {
  private readonly byName = new Map<string, Detector>();
  private readonly initialized = new Set<string>();
  private readonly perDetectorTimeoutMs: number;
  private readonly logger?: Logger;

  constructor(opts: DetectorRegistryOptions = {}) {
    this.perDetectorTimeoutMs = opts.perDetectorTimeoutMs ?? 200;
    this.logger = opts.logger;
  }

  register(detector: Detector): void {
    if (this.byName.has(detector.name)) {
      throw new Error(`detector already registered: ${detector.name}`);
    }
    this.byName.set(detector.name, detector);
  }

  unregister(name: string): boolean {
    this.initialized.delete(name);
    return this.byName.delete(name);
  }

  get(name: string): Detector | undefined {
    return this.byName.get(name);
  }

  list(): Detector[] {
    return [...this.byName.values()];
  }

  /**
   * Run every detector. Meta-kind detectors see signals from earlier kinds
   * via ctx.upstream. Individual detector failures (throw / timeout) are
   * isolated and logged — they never crash the chain.
   */
  async evaluateAll(ctx: DetectorContext): Promise<Signal[]> {
    const all: Signal[] = [];
    for (const kind of KIND_ORDER) {
      const detectors = [...this.byName.values()].filter(d => d.kind === kind);
      for (const d of detectors) {
        await this.maybeInit(d);
        const passCtx: DetectorContext = { ...ctx, upstream: all };
        try {
          const signals = await this.runWithTimeout(d, passCtx);
          for (const s of signals) all.push(s);
        } catch (err) {
          this.logger?.warn(
            { detector: d.name, err: (err as Error).message },
            'detector evaluate failed — skipped',
          );
        }
      }
    }
    return all;
  }

  private async maybeInit(d: Detector): Promise<void> {
    if (this.initialized.has(d.name)) return;
    if (d.init) await d.init();
    this.initialized.add(d.name);
  }

  private runWithTimeout(d: Detector, ctx: DetectorContext): Promise<Signal[]> {
    const work = Promise.resolve().then(() => d.evaluate(ctx));
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`detector ${d.name} exceeded ${this.perDetectorTimeoutMs}ms`)),
        this.perDetectorTimeoutMs,
      );
    });
    return Promise.race([work, timeout]);
  }
}
