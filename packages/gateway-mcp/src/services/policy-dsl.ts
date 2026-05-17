/**
 * Per-tenant DSL cache + evaluation orchestration.
 *
 * - Owns one DslEvaluator per orgId (recompiled on tenant-config updates).
 * - Subscribes to ConfigBus so writes via TenantConfigService PATCH/apply
 *   invalidate the cache automatically.
 * - Compile failures keep the previously good evaluator and log a warning
 *   (fail-open on parse, fail-safe on runtime — the evaluator itself only
 *   ever recommends tightening).
 */

import { Logger } from 'pino';
import { PolicyDsl } from '@agentguard/core-schema';
import { ConfigBus } from './config-bus';
import { TenantConfigService } from './tenant-config';
import { CompiledDsl, DslCompileError, compileValidated } from '../policies/dsl/ast';
import { DslContext, DslEvaluator, MatchResult } from '../policies/dsl/evaluator';

interface CacheEntry {
  evaluator: DslEvaluator | null;
  sourceVersion: number;
}

export class DslPolicyService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private logger: Logger,
    bus: ConfigBus,
    private tenantConfig: TenantConfigService,
  ) {
    bus.onConfigChange((event) => {
      if (event.type !== 'tenant.config.updated') return;
      this.recompile(event.orgId, event.config.dsl);
    });
  }

  /** Build evaluators for every org at startup. */
  warmCache(orgIds: string[]): void {
    for (const orgId of orgIds) {
      const cfg = this.tenantConfig.get(orgId);
      this.recompile(orgId, cfg.dsl);
    }
  }

  getEvaluator(orgId: string): DslEvaluator | null {
    const cached = this.cache.get(orgId);
    if (cached) return cached.evaluator;
    // Lazy-load if cold (e.g. new tenant created mid-flight)
    const cfg = this.tenantConfig.get(orgId);
    this.recompile(orgId, cfg.dsl);
    return this.cache.get(orgId)?.evaluator ?? null;
  }

  evaluate(orgId: string, ctx: DslContext): MatchResult | null {
    const evaluator = this.getEvaluator(orgId);
    if (!evaluator) return null;
    try {
      return evaluator.evaluate(ctx);
    } catch (err) {
      this.logger.error(
        { orgId, err: (err as Error).message },
        'DSL evaluation threw — treating as no-match',
      );
      return null;
    }
  }

  /**
   * Stand-alone helper used by /api/v1/dsl/dry-run. Compiles a candidate DSL
   * fresh and evaluates it against a caller-supplied context without
   * touching cache. Returns either the match (null if no rule matched) or
   * throws DslCompileError.
   */
  dryRun(dsl: PolicyDsl, ctx: DslContext): MatchResult | null {
    const compiled = compileValidated(dsl);
    return new DslEvaluator(compiled).evaluate(ctx);
  }

  private recompile(orgId: string, dsl: PolicyDsl | undefined): void {
    if (!dsl) {
      this.cache.set(orgId, { evaluator: null, sourceVersion: 0 });
      return;
    }
    try {
      const compiled: CompiledDsl = compileValidated(dsl);
      this.cache.set(orgId, {
        evaluator: new DslEvaluator(compiled),
        sourceVersion: dsl.version,
      });
      this.logger.debug(
        { orgId, ruleCount: compiled.rules.length },
        'DSL recompiled for tenant',
      );
    } catch (err) {
      const prev = this.cache.get(orgId);
      this.logger.warn(
        {
          orgId,
          err: err instanceof DslCompileError ? err.message : String(err),
        },
        'DSL compile failed — keeping previous evaluator',
      );
      if (!prev) {
        this.cache.set(orgId, { evaluator: null, sourceVersion: 0 });
      }
    }
  }
}
