/**
 * Typed read/write/template-apply on the organizations.settings JSON blob.
 *
 * Source of truth is SQLite. In-memory cache is write-through (only updated
 * after a successful DB commit). On read miss, falls back to DB; on DB miss
 * (tenant has empty settings) returns the standard template defaults.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import {
  TenantConfig,
  TenantConfigSchema,
} from '@agentguard/core-schema';
import { ConfigBus } from './config-bus';
import { AuditLogService } from './audit-log';
import {
  DEFAULT_TEMPLATE,
  TemplateMeta,
  TemplateName,
  getTemplate,
  listTemplates,
} from '../policies/templates';

export interface UpdateContext {
  userEmail?: string;
  userId?: string;
  ipAddress?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` into `base`. Arrays are replaced wholesale. */
function deepMerge<T extends Record<string, any>>(base: T, patch: any): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** Minimal view of the template registry the tenant-config service
 *  needs. Decouples the service from the concrete registry class so
 *  tests can pass in a stub. */
export interface TemplateLookup {
  get(id: string): { config: TenantConfig; description: string } | null;
  list(): Array<{ name: string; description: string; config: TenantConfig; source?: 'builtin' | 'custom' }>;
}

export class TenantConfigService {
  private cache = new Map<string, TenantConfig>();
  private selectStmt: Database.Statement;
  private updateStmt: Database.Statement;
  /** Optional — when injected, applyTemplate accepts any registry id
   *  (built-in or operator-registered). When absent, falls back to the
   *  hardcoded TemplateName enum. */
  private templateLookup?: TemplateLookup;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private bus: ConfigBus,
    private auditLog: AuditLogService,
  ) {
    this.selectStmt = db.prepare(
      'SELECT settings FROM organizations WHERE id = ?',
    );
    this.updateStmt = db.prepare(
      `UPDATE organizations SET settings = ?, updated_at = datetime('now') WHERE id = ?`,
    );
  }

  /**
   * Seed defaults for any organization whose settings is still the empty
   * JSON object. Safe to call multiple times — non-empty settings are left
   * untouched. Emits a `seed`-source event so subscribers can warm caches.
   */
  seedDefaults(): { seeded: number; orgIds: string[] } {
    const orgs = this.db
      .prepare('SELECT id, settings FROM organizations')
      .all() as { id: string; settings: string | null }[];
    const seeded: string[] = [];
    const template = getTemplate(DEFAULT_TEMPLATE);
    if (!template) {
      throw new Error(`Default template "${DEFAULT_TEMPLATE}" not found`);
    }

    for (const row of orgs) {
      const raw = row.settings ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        parsed = {};
      }
      const isEmpty =
        !parsed ||
        (isPlainObject(parsed) && Object.keys(parsed).length === 0);
      if (!isEmpty) {
        // Hydrate cache without overwriting.
        const validated = TenantConfigSchema.safeParse(parsed);
        if (validated.success) this.cache.set(row.id, validated.data);
        continue;
      }
      const fresh: TenantConfig = {
        ...template.config,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system:seed',
      };
      this.updateStmt.run(JSON.stringify(fresh), row.id);
      this.cache.set(row.id, fresh);
      seeded.push(row.id);
      this.bus.emitConfigChange({
        type: 'tenant.config.updated',
        orgId: row.id,
        config: fresh,
        source: 'seed',
      });
    }

    if (seeded.length > 0) {
      this.logger.info(
        { count: seeded.length },
        'Seeded default TenantConfig for orgs with empty settings',
      );
    }
    return { seeded: seeded.length, orgIds: seeded };
  }

  /** Read tenant config. Falls back to standard template if missing. */
  get(orgId: string): TenantConfig {
    const cached = this.cache.get(orgId);
    if (cached) return cached;

    const row = this.selectStmt.get(orgId) as
      | { settings: string | null }
      | undefined;

    if (row && row.settings) {
      try {
        const parsed = JSON.parse(row.settings);
        const result = TenantConfigSchema.safeParse(parsed);
        if (result.success) {
          this.cache.set(orgId, result.data);
          return result.data;
        }
        this.logger.warn(
          { orgId, issues: result.error.issues },
          'organizations.settings failed TenantConfig validation; returning defaults',
        );
      } catch (err) {
        this.logger.warn(
          { orgId, err: (err as Error).message },
          'organizations.settings is not valid JSON; returning defaults',
        );
      }
    }

    const fallback = getTemplate(DEFAULT_TEMPLATE)!.config;
    return fallback;
  }

  /** Full replace. Body must be a complete, valid TenantConfig. */
  replace(orgId: string, full: TenantConfig, ctx: UpdateContext): TenantConfig {
    this.assertOrgExists(orgId);
    const validated = TenantConfigSchema.parse({
      ...full,
      deploymentMode: full.deploymentMode ?? 'custom',
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userEmail ?? ctx.userId ?? 'api',
    });
    this.persistAndEmit(orgId, validated, 'replace', ctx);
    return validated;
  }

  /** Deep-merge partial update. */
  update(
    orgId: string,
    patch: any,
    ctx: UpdateContext,
  ): TenantConfig {
    this.assertOrgExists(orgId);
    const current = this.get(orgId);
    const merged = deepMerge(current, patch);
    // Patch may flip deploymentMode away from a template; mark as custom.
    if (
      patch &&
      isPlainObject(patch) &&
      patch.deploymentMode === undefined &&
      current.deploymentMode !== 'custom'
    ) {
      merged.deploymentMode = 'custom';
    }
    merged.updatedAt = new Date().toISOString();
    merged.updatedBy = ctx.userEmail ?? ctx.userId ?? 'api';
    const validated = TenantConfigSchema.parse(merged);
    this.persistAndEmit(orgId, validated, 'update', ctx);
    return validated;
  }

  /** Inject the merged (built-in + operator-registered) lookup. */
  setTemplateLookup(lookup: TemplateLookup): void {
    this.templateLookup = lookup;
  }

  /** Replace config with the named template (deep-clone to avoid sharing). */
  applyTemplate(
    orgId: string,
    name: string,
    ctx: UpdateContext,
  ): TenantConfig {
    this.assertOrgExists(orgId);
    // Prefer the injected merged lookup (built-in + operator-registered);
    // fall back to the hardcoded built-in templates for tests / older
    // wiring paths that don't pass a lookup.
    const template = this.templateLookup
      ? this.templateLookup.get(name)
      : getTemplate(name as TemplateName);
    if (!template) {
      const err = new Error(`Unknown template: ${name}`);
      (err as any).status = 404;
      throw err;
    }
    const fresh: TenantConfig = {
      ...JSON.parse(JSON.stringify(template.config)),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userEmail ?? ctx.userId ?? 'api',
    };
    const validated = TenantConfigSchema.parse(fresh);
    this.persistAndEmit(orgId, validated, 'apply-template', ctx);
    return validated;
  }

  listTemplates(): Array<{ name: string; description: string; config: TenantConfig; source?: 'builtin' | 'custom' }> {
    return this.templateLookup ? this.templateLookup.list() : listTemplates();
  }

  getTemplate(name: string): { name: string; description: string; config: TenantConfig } | null {
    if (this.templateLookup) {
      const t = this.templateLookup.get(name);
      return t ? { name, description: t.description, config: t.config } : null;
    }
    return getTemplate(name as TemplateName);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private assertOrgExists(orgId: string): void {
    const row = this.db
      .prepare('SELECT id FROM organizations WHERE id = ?')
      .get(orgId);
    if (!row) {
      const err = new Error(`Organization not found: ${orgId}`);
      (err as any).status = 404;
      throw err;
    }
  }

  private persistAndEmit(
    orgId: string,
    config: TenantConfig,
    source: 'update' | 'replace' | 'apply-template',
    ctx: UpdateContext,
  ): void {
    this.updateStmt.run(JSON.stringify(config), orgId);
    this.cache.set(orgId, config);

    this.auditLog.log({
      org_id: orgId,
      user_email: ctx.userEmail,
      user_id: ctx.userId,
      action: `tenant.config.${source}`,
      resource_type: 'organization',
      resource_id: orgId,
      details: {
        deploymentMode: config.deploymentMode,
        layers: config.layers,
        retentionDays: config.retention.days,
      },
      ip_address: ctx.ipAddress,
    });

    this.bus.emitConfigChange({
      type: 'tenant.config.updated',
      orgId,
      config,
      source,
    });
  }
}
