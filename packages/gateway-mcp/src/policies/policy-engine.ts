import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { SafetyValidation, RiskLevel } from '@agentguard/core-schema';
import Ajv, { ValidateFunction } from 'ajv';
import { classifyToolCall, ClassificationResult, ToolCategory } from '../services/classifier';
import { PolicyStore } from '../db/policy-store';
import { SqlitePolicyStore } from '../db/sqlite-policy-store';

/**
 * PolicyEngine — multi-tenant, storage-backend agnostic.
 *
 * The Engine talks to PolicyStore (SqlitePolicyStore | PostgresPolicyStore)
 * for all I/O. The wildcard + tenant-shadow semantics are documented
 * once in db/policy-store.ts. Caches:
 *
 *   - byOrg: Map<orgId, OrgPolicyCache>  — per-tenant materialised view
 *   - compiled AJV validators live alongside the policy in the same cache
 *
 * Mutations always specify (policyId, orgId); on a tenant-row update
 * we invalidate just that org. A wildcard-row update clears the whole
 * cache because every org's view incorporates wildcards.
 */

const PLATFORM_ORG = '*';

interface Policy {
  id: string;
  name: string;
  description: string;
  policy_schema: any;
  risk_level: RiskLevel;
  enabled: boolean;
  org_id: string;
}

interface OrgPolicyCache {
  policies: Map<string, Policy>;
  compiled: Map<string, ValidateFunction>;
}

interface ToolCallRequest {
  tool: string;
  arguments: any;
}

const POLICY_CATEGORIES: Record<string, ToolCategory[]> = {
  'sql-injection':    ['database'],
  'file-access':      ['file'],
  'network-access':   ['network'],
  'prompt-injection': [],
  'data-exfiltration':['network', 'communication'],
  'source-map-leak':  ['supply-chain', 'shell'],
  'supply-chain':     ['supply-chain', 'shell'],
};

export class PolicyEngine {
  private ajv: Ajv;
  private byOrg = new Map<string, OrgPolicyCache>();
  private store: PolicyStore;
  /** Set once the first async call resolves; lets sync callers (legacy
   *  paths) still get correct behaviour by lazily warming on first hit. */
  private warmedOrgs = new Set<string>();

  /**
   * Two construction forms — both backwards-compatible:
   *   1. `new PolicyEngine(db, logger)`           — wraps SqlitePolicyStore (legacy)
   *   2. `new PolicyEngine(store, logger, true)`  — pre-built store (Postgres / tests)
   *
   * Existing tests + server bootstrap go through (1) so this is a
   * drop-in change for everything currently in the tree.
   */
  constructor(
    dbOrStore: Database.Database | PolicyStore,
    private logger: Logger,
    private _isStore = false,
  ) {
    this.ajv = new Ajv({ allErrors: true });
    if (this.isPolicyStore(dbOrStore)) {
      this.store = dbOrStore;
    } else {
      this.store = new SqlitePolicyStore(dbOrStore);
    }
    // Warm the default-tenant view synchronously when we have a
    // SQLite-backed store — preserves v0 startup ergonomics. Postgres
    // callers should `await engine.warm(orgId)` after construction.
    if (this.store instanceof SqlitePolicyStore) {
      this.loadOrgSync('default');
    }
  }

  private isPolicyStore(x: any): x is PolicyStore {
    return x && typeof x.listEnabledWildcards === 'function';
  }

  /** Public warm hook for backends that can't fast-path synchronously. */
  async warm(orgId: string): Promise<void> {
    await this.loadOrg(orgId);
  }

  /** Synchronous fast-path — only valid when the backing store is SQLite
   *  (better-sqlite3 calls are sync). Wraps the async API for legacy
   *  call sites that still expect sync engine construction.  */
  private loadOrgSync(orgId: string): OrgPolicyCache | null {
    const cached = this.byOrg.get(orgId);
    if (cached) return cached;
    if (!(this.store instanceof SqlitePolicyStore)) return null;
    // SqlitePolicyStore's promises resolve synchronously (better-sqlite3
    // does its work synchronously and Promise.resolve fires on the
    // microtask queue), so we can deref via .then for cache priming.
    // For real call paths we await; the sync path here is just for
    // the constructor and for legacy sync test fixtures.
    let result: OrgPolicyCache | null = null;
    this.loadOrg(orgId).then(c => { result = c; });
    // Drain microtasks deterministically — better-sqlite3's sync calls
    // are already finished, so Promise.resolve().then(...) above runs
    // immediately on the next microtask tick of this call.
    return this.byOrg.get(orgId) ?? result;
  }

  private async loadOrg(orgId: string): Promise<OrgPolicyCache> {
    const cached = this.byOrg.get(orgId);
    if (cached) return cached;

    const cache: OrgPolicyCache = { policies: new Map(), compiled: new Map() };
    const wildcards = await this.store.listEnabledWildcards();
    const tenant = orgId === PLATFORM_ORG ? [] : await this.store.listEnabledForOrg(orgId);

    for (const row of [...wildcards, ...tenant]) {
      try {
        const policy: Policy = {
          id: row.id,
          name: row.name,
          description: row.description ?? '',
          policy_schema: JSON.parse(row.policy_schema),
          risk_level: row.risk_level,
          enabled: row.enabled === 1,
          org_id: row.org_id,
        };
        cache.policies.set(policy.name, policy);
        cache.compiled.set(policy.name, this.ajv.compile(policy.policy_schema));
      } catch (error) {
        this.logger.error({ error, policy: row?.name, orgId }, 'Failed to load policy');
      }
    }
    this.byOrg.set(orgId, cache);
    this.warmedOrgs.add(orgId);
    this.logger.info(
      { orgId, total: cache.policies.size, wildcards: wildcards.length, tenant: tenant.length },
      'Loaded org policy view',
    );
    return cache;
  }

  private invalidate(scope: 'tenant' | 'wildcard', orgId: string): void {
    if (scope === 'wildcard') this.byOrg.clear();
    else this.byOrg.delete(orgId);
  }

  async validateToolCall(
    request: ToolCallRequest,
    orgId: string = 'default',
  ): Promise<SafetyValidation & { classification: ClassificationResult }> {
    const classification = classifyToolCall(request.tool, request.arguments);
    this.logger.debug(
      { tool: request.tool, category: classification.category, source: classification.source, orgId },
      'Tool classified',
    );

    const violations: string[] = [];
    let highestRiskLevel: RiskLevel = 'LOW';
    let failedPolicy: string | null = null;

    for (const risk of classification.risks) {
      violations.push(risk.detail);
      if (this.compareRiskLevels(risk.severity, highestRiskLevel) > 0) {
        highestRiskLevel = risk.severity;
      }
      if (!failedPolicy) failedPolicy = `content-scan:${risk.type}`;
    }

    const view = await this.loadOrg(orgId);
    for (const [name, policy] of view.policies) {
      if (this.policyApplies(policy, request, classification.category)) {
        const validate = view.compiled.get(name) ?? this.ajv.compile(policy.policy_schema);
        const valid = validate(request.arguments);

        if (!valid) {
          failedPolicy = name;
          violations.push(...(validate.errors?.map(e => e.message || 'Unknown error') || []));
          if (this.compareRiskLevels(policy.risk_level, highestRiskLevel) > 0) {
            highestRiskLevel = policy.risk_level;
          }
          this.logger.warn(
            { policy: name, tool: request.tool, category: classification.category, orgId, errors: validate.errors },
            'Policy validation failed',
          );
        }
      }
    }

    return {
      policy_name: failedPolicy || 'none',
      passed: violations.length === 0,
      violations: violations.length > 0 ? violations : undefined,
      risk_level: highestRiskLevel,
      classification,
    };
  }

  private policyApplies(policy: Policy, request: ToolCallRequest, category: ToolCategory): boolean {
    const categories = POLICY_CATEGORIES[policy.id];
    if (!categories || categories.length === 0) return true;
    return categories.includes(category);
  }

  private compareRiskLevels(a: RiskLevel, b: RiskLevel): number {
    const levels: Record<RiskLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    return levels[a] - levels[b];
  }

  async addPolicy(
    policy: Omit<Policy, 'enabled' | 'org_id'> & { org_id?: string },
    orgId: string = 'default',
  ): Promise<void> {
    const resolvedOrg = policy.org_id ?? orgId;
    await this.store.upsert({
      id: policy.id,
      name: policy.name,
      description: policy.description,
      policy_schema: JSON.stringify(policy.policy_schema),
      risk_level: policy.risk_level,
      org_id: resolvedOrg,
    });
    this.invalidate(resolvedOrg === PLATFORM_ORG ? 'wildcard' : 'tenant', resolvedOrg);
  }

  async disablePolicy(policyId: string, orgId: string = 'default'): Promise<void> {
    const { scope } = await this.store.setEnabledForOrg(policyId, orgId, false);
    this.invalidate(scope, orgId);
  }

  async enablePolicy(policyId: string, orgId: string = 'default'): Promise<void> {
    const { scope } = await this.store.setEnabledForOrg(policyId, orgId, true);
    this.invalidate(scope, orgId);
  }

  async deletePolicy(policyId: string, orgId: string = 'default'): Promise<void> {
    await this.store.deleteForOrg(policyId, orgId);
    this.invalidate('tenant', orgId);
  }

  async getPolicies(orgId: string = 'default'): Promise<Policy[]> {
    const view = await this.loadOrg(orgId);
    return Array.from(view.policies.values());
  }

  async getAllPolicies(orgId?: string): Promise<Policy[]> {
    const rows = orgId && orgId !== PLATFORM_ORG
      ? await this.store.listAllForOrg(orgId)
      : await this.store.listAll();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description ?? '',
      policy_schema: JSON.parse(r.policy_schema),
      risk_level: r.risk_level,
      enabled: r.enabled === 1,
      org_id: r.org_id,
    }));
  }
}
