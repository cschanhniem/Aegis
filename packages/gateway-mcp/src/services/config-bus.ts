/**
 * In-process pub/sub for tenant-config changes.
 *
 * Separate from services/event-bus.ts (which is a ring buffer for HTTP
 * polling of policy violations). This one is a real EventEmitter so services
 * can subscribe and react to config edits without restarting.
 *
 * P1.2 scope: emit-side wired into TenantConfigService; one debug-log
 * subscriber. Downstream services (PolicyEngine, AnomalyDetector,
 * ProfileManager) wire their subscriptions in later tasks (P1.1+).
 */

import { EventEmitter } from 'node:events';
import { Logger } from 'pino';
import { TenantConfig } from '@agentguard/core-schema';

export type ConfigEvent =
  | {
      type: 'tenant.config.updated';
      orgId: string;
      config: TenantConfig;
      source: 'update' | 'replace' | 'apply-template' | 'seed';
    }
  | {
      type: 'tenant.config.deleted';
      orgId: string;
    };

const EVENT_NAME = 'config';

export class ConfigBus {
  private emitter = new EventEmitter();

  constructor(private logger: Logger) {
    this.emitter.setMaxListeners(64);

    // Built-in debug subscriber so wiring is verifiable in dev logs.
    this.onConfigChange((event) => {
      if (event.type === 'tenant.config.updated') {
        this.logger.debug(
          { orgId: event.orgId, source: event.source, mode: event.config.deploymentMode },
          'tenant.config.updated',
        );
      } else {
        this.logger.debug({ orgId: event.orgId }, 'tenant.config.deleted');
      }
    });
  }

  emitConfigChange(event: ConfigEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  /** Returns an unsubscribe function. */
  onConfigChange(handler: (event: ConfigEvent) => void): () => void {
    this.emitter.on(EVENT_NAME, handler);
    return () => this.emitter.off(EVENT_NAME, handler);
  }
}
