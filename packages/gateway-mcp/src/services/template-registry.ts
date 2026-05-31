/**
 * TemplateRegistryService — merges built-in deployment templates with
 * operator-registered customs.
 *
 * Storage: customs persist in `gateway_config` under
 * `template:<id>` (one row per template). Gateway-scoped, shared across
 * all tenants, mutable via REST.
 *
 * Lookup precedence: built-in > custom. Reserved IDs are rejected at
 * registration time.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import {
  CustomTemplateInput,
  CustomTemplateSpec,
  CustomTemplateSpecSchema,
  TenantConfig,
  TenantConfigSchema,
  RESERVED_TEMPLATE_IDS,
} from '@agentguard/core-schema';
import {
  listTemplates as builtinList,
  getTemplate as builtinGet,
  TemplateName as BuiltinName,
  TemplateMeta,
} from '../policies/templates';

export interface MergedTemplate extends TemplateMeta {
  source: 'builtin' | 'custom';
}

const KEY_PREFIX = 'template:';

export class TemplateRegistryService {
  constructor(private db: Database.Database, private logger: Logger) {}

  list(): MergedTemplate[] {
    const out: MergedTemplate[] = builtinList().map(t => ({ ...t, source: 'builtin' as const }));
    for (const custom of this.allCustoms()) {
      out.push({
        name: custom.id as BuiltinName,
        description: custom.description ?? custom.name,
        config: custom.config,
        source: 'custom',
      });
    }
    return out;
  }

  get(id: string): MergedTemplate | null {
    // Built-in first (so a stale custom row can't shadow a built-in by ID;
    // RESERVED_TEMPLATE_IDS prevents registration but defense in depth).
    if (this.isBuiltinName(id)) {
      const t = builtinGet(id as BuiltinName);
      return t ? { ...t, source: 'builtin' } : null;
    }
    const row = this.db.prepare(
      `SELECT value FROM gateway_config WHERE key = ?`,
    ).get(KEY_PREFIX + id) as { value: string } | undefined;
    if (!row) return null;
    try {
      const spec = CustomTemplateSpecSchema.parse(JSON.parse(row.value));
      return { name: spec.id as BuiltinName, description: spec.description ?? spec.name, config: spec.config, source: 'custom' };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, id }, 'custom template parse failed');
      return null;
    }
  }

  /** Returns true if `id` resolves to either a built-in or a registered
   *  custom — used by /apply-template to widen the accepted set. */
  exists(id: string): boolean {
    return this.get(id) !== null;
  }

  register(input: CustomTemplateInput): CustomTemplateSpec {
    const parsed = CustomTemplateSpecSchema.parse(input);
    if (RESERVED_TEMPLATE_IDS.includes(parsed.id)) {
      const err = new Error(`Template id "${parsed.id}" is reserved for a built-in`);
      (err as any).status = 409;
      throw err;
    }
    // Force deploymentMode='custom' on persisted config to avoid the
    // operator accidentally claiming a built-in mode.
    const config: TenantConfig = TenantConfigSchema.parse({
      ...parsed.config,
      deploymentMode: 'custom',
    });
    const stored: CustomTemplateSpec = { ...parsed, config };
    this.db.prepare(
      `INSERT INTO gateway_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(KEY_PREFIX + stored.id, JSON.stringify(stored));
    return stored;
  }

  delete(id: string): boolean {
    if (RESERVED_TEMPLATE_IDS.includes(id)) {
      const err = new Error(`Template id "${id}" is a built-in and cannot be deleted`);
      (err as any).status = 400;
      throw err;
    }
    const r = this.db.prepare(`DELETE FROM gateway_config WHERE key = ?`).run(KEY_PREFIX + id);
    return r.changes > 0;
  }

  private allCustoms(): CustomTemplateSpec[] {
    const rows = this.db.prepare(
      `SELECT value FROM gateway_config WHERE key LIKE ?`,
    ).all(KEY_PREFIX + '%') as Array<{ value: string }>;
    const out: CustomTemplateSpec[] = [];
    for (const row of rows) {
      try { out.push(CustomTemplateSpecSchema.parse(JSON.parse(row.value))); }
      catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'custom template parse failed during list');
      }
    }
    return out;
  }

  private isBuiltinName(id: string): id is BuiltinName {
    return ['dev', 'standard', 'strict', 'financial', 'healthcare'].includes(id);
  }
}
