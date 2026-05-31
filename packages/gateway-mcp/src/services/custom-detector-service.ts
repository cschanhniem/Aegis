/**
 * CustomDetectorService — manages the lifecycle of operator-uploaded
 * detectors. On startup it walks every tenant's customDetectors[] and
 * registers them; on ConfigBus update it diffs the live set against the
 * new config and registers / unregisters incrementally.
 *
 * Naming convention: detector name is `tenant.<orgId>.<spec.name>`. The
 * registry sees these as normal Detector instances; the per-tenant gate
 * inside DeclarativeDetector.evaluate() ensures they only emit for the
 * owning tenant.
 *
 * Failure mode on bad spec: log + skip that detector; the rest of the
 * tenant's detectors stay live. Matches the DSL service's fail-open-on-
 * parse / fail-safe-on-runtime stance.
 */

import { Logger } from 'pino';
import { CustomDetectorSpec } from '@agentguard/core-schema';
import { DetectorRegistry } from '../detectors/registry';
import { DeclarativeDetector } from '../detectors/declarative-detector';
import { TenantConfigService } from './tenant-config';
import { ConfigBus } from './config-bus';

export class CustomDetectorService {
  /** registered detector names by org, so we can diff on reload. */
  private byOrg = new Map<string, Set<string>>();
  private unsubscribe?: () => void;

  constructor(
    private logger: Logger,
    private registry: DetectorRegistry,
    private tenantConfig: TenantConfigService,
    private configBus: ConfigBus,
  ) {}

  start(orgIds: ReadonlyArray<string>): void {
    for (const orgId of orgIds) this.reloadOrg(orgId);
    this.unsubscribe = this.configBus.onConfigChange(evt => {
      if (evt.type === 'tenant.config.updated' && evt.orgId) this.reloadOrg(evt.orgId);
      if (evt.type === 'tenant.config.deleted' && evt.orgId) this.dropOrg(evt.orgId);
    });
  }

  reloadOrg(orgId: string): void {
    const cfg = this.tenantConfig.get(orgId);
    const desired: CustomDetectorSpec[] = cfg.customDetectors ?? [];
    const desiredNames = new Set(desired.map(s => `tenant.${orgId}.${s.name}`));
    const live = this.byOrg.get(orgId) ?? new Set<string>();

    // Drop detectors that are gone or renamed.
    for (const name of live) {
      if (!desiredNames.has(name)) {
        this.registry.unregister(name);
        live.delete(name);
      }
    }

    // Register / re-register the rest.
    for (const spec of desired) {
      const fullName = `tenant.${orgId}.${spec.name}`;
      if (live.has(fullName)) this.registry.unregister(fullName);
      try {
        this.registry.register(new DeclarativeDetector(orgId, spec));
        live.add(fullName);
      } catch (err) {
        this.logger.warn(
          { orgId, detector: spec.name, err: (err as Error).message },
          'custom detector compile failed — skipped',
        );
      }
    }
    this.byOrg.set(orgId, live);
  }

  private dropOrg(orgId: string): void {
    const live = this.byOrg.get(orgId);
    if (!live) return;
    for (const name of live) this.registry.unregister(name);
    this.byOrg.delete(orgId);
  }

  /** Stop subscribing + drop all custom detectors. Used by tests. */
  stop(): void {
    this.unsubscribe?.();
    for (const [orgId] of this.byOrg) this.dropOrg(orgId);
  }

  /** Read-only view of what's currently registered for an org. */
  listLive(orgId: string): ReadonlyArray<string> {
    return [...(this.byOrg.get(orgId) ?? new Set())];
  }
}
