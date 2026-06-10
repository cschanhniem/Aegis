import Database from 'better-sqlite3';
import pino from 'pino';
import { TenantBaselineService } from '../services/tenant-baseline';
import { FEATURE_DIM } from '../services/feature-encoder';

function setup() {
  const db = new Database(':memory:');
  // Schema subset: agents (registry) + agent_profiles
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE agent_profiles (
      agent_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      trace_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return { db, svc: new TenantBaselineService(db, pino({ level: 'silent' })) };
}

function seedAgent(db: Database.Database, opts: {
  agentId: string; orgId: string; mean: number[]; variance: number[]; n: number;
}) {
  db.prepare(`INSERT INTO agents (id, org_id) VALUES (?, ?)`).run(opts.agentId, opts.orgId);
  db.prepare(
    `INSERT INTO agent_profiles (agent_id, profile_json) VALUES (?, ?)`,
  ).run(opts.agentId, JSON.stringify({
    featureStats: { mean: opts.mean, variance: opts.variance, n: opts.n },
  }));
}

describe('TenantBaselineService', () => {
  it('returns null when the tenant has no agents', () => {
    const { svc } = setup();
    expect(svc.getBaseline('empty-org')).toBeNull();
  });

  it('aggregates feature_stats across multiple agents (trimmed mean + median variance)', () => {
    const { db, svc } = setup();
    // Three agents with means = [0, 5, 10] on dim 0; trimmed-mean drops
    // top/bottom 5% (=0 from 3 values), so the mean should be (0+5+10)/3 = 5.
    seedAgent(db, { agentId: 'a-1', orgId: 'org-1', mean: filled(FEATURE_DIM, 0), variance: filled(FEATURE_DIM, 1), n: 50 });
    seedAgent(db, { agentId: 'a-2', orgId: 'org-1', mean: filled(FEATURE_DIM, 5), variance: filled(FEATURE_DIM, 2), n: 100 });
    seedAgent(db, { agentId: 'a-3', orgId: 'org-1', mean: filled(FEATURE_DIM, 10), variance: filled(FEATURE_DIM, 3), n: 30 });

    const baseline = svc.getBaseline('org-1')!;
    expect(baseline.mean).toHaveLength(FEATURE_DIM);
    expect(baseline.mean[0]).toBeCloseTo(5, 5);
    // Median variance of [1, 2, 3] = 2
    expect(baseline.variance[0]).toBeCloseTo(2, 5);
    expect(baseline.total_samples).toBe(180);
    expect(baseline.agent_count).toBe(3);
  });

  it('skips agents whose featureStats.n < 5 (filters out cold-start contributors)', () => {
    const { db, svc } = setup();
    seedAgent(db, { agentId: 'a-warm', orgId: 'org-1', mean: filled(FEATURE_DIM, 10), variance: filled(FEATURE_DIM, 1), n: 50 });
    seedAgent(db, { agentId: 'a-cold', orgId: 'org-1', mean: filled(FEATURE_DIM, 999), variance: filled(FEATURE_DIM, 999), n: 3 });
    const baseline = svc.getBaseline('org-1')!;
    expect(baseline.mean[0]).toBeCloseTo(10);   // cold agent excluded
    expect(baseline.agent_count).toBe(1);
  });

  it('cross-tenant isolation: agents in other orgs ignored', () => {
    const { db, svc } = setup();
    seedAgent(db, { agentId: 'a-A', orgId: 'org-A', mean: filled(FEATURE_DIM, 1), variance: filled(FEATURE_DIM, 0.1), n: 50 });
    seedAgent(db, { agentId: 'a-B', orgId: 'org-B', mean: filled(FEATURE_DIM, 100), variance: filled(FEATURE_DIM, 50), n: 50 });
    const baselineA = svc.getBaseline('org-A')!;
    expect(baselineA.mean[0]).toBeCloseTo(1);
    expect(baselineA.agent_count).toBe(1);
  });

  it('skips agents missing from the registry (ghost profiles)', () => {
    const { db, svc } = setup();
    // No row in `agents` table for "ghost"
    db.prepare(`INSERT INTO agent_profiles (agent_id, profile_json) VALUES (?, ?)`)
      .run('ghost', JSON.stringify({ featureStats: { mean: filled(FEATURE_DIM, 999), variance: filled(FEATURE_DIM, 999), n: 50 } }));
    seedAgent(db, { agentId: 'real', orgId: 'org-1', mean: filled(FEATURE_DIM, 7), variance: filled(FEATURE_DIM, 1), n: 50 });
    const baseline = svc.getBaseline('org-1')!;
    expect(baseline.mean[0]).toBeCloseTo(7);
    expect(baseline.agent_count).toBe(1);
  });

  it('cache TTL: getBaseline returns same object inside TTL window', () => {
    const { db, svc } = setup();
    seedAgent(db, { agentId: 'a', orgId: 'org-1', mean: filled(FEATURE_DIM, 1), variance: filled(FEATURE_DIM, 1), n: 50 });
    const b1 = svc.getBaseline('org-1')!;
    const b2 = svc.getBaseline('org-1')!;
    expect(b1).toBe(b2);   // cached identity
  });

  it('invalidate(orgId) forces a fresh compute on next get', () => {
    const { db, svc } = setup();
    seedAgent(db, { agentId: 'a', orgId: 'org-1', mean: filled(FEATURE_DIM, 1), variance: filled(FEATURE_DIM, 1), n: 50 });
    const b1 = svc.getBaseline('org-1')!;
    svc.invalidate('org-1');
    const b2 = svc.getBaseline('org-1')!;
    // Different object reference (re-computed) but same value
    expect(b1).not.toBe(b2);
    expect(b1.mean).toEqual(b2.mean);
  });

  it('handles malformed profile JSON gracefully (silently skipped)', () => {
    const { db, svc } = setup();
    db.prepare(`INSERT INTO agents (id, org_id) VALUES ('malformed', 'org-1')`).run();
    db.prepare(`INSERT INTO agent_profiles (agent_id, profile_json) VALUES ('malformed', '{not json')`).run();
    seedAgent(db, { agentId: 'real', orgId: 'org-1', mean: filled(FEATURE_DIM, 3), variance: filled(FEATURE_DIM, 1), n: 50 });
    const baseline = svc.getBaseline('org-1')!;
    expect(baseline.agent_count).toBe(1);
    expect(baseline.mean[0]).toBeCloseTo(3);
  });

  it('trimmed mean drops outliers when there are enough samples', () => {
    const { db, svc } = setup();
    // 20 agents, one with extreme outlier on dim 0
    for (let i = 0; i < 19; i++) {
      seedAgent(db, { agentId: `a-${i}`, orgId: 'org-1',
        mean: filled(FEATURE_DIM, 5), variance: filled(FEATURE_DIM, 1), n: 50 });
    }
    seedAgent(db, { agentId: 'outlier', orgId: 'org-1',
      mean: filled(FEATURE_DIM, 10000), variance: filled(FEATURE_DIM, 1000), n: 50 });
    const baseline = svc.getBaseline('org-1')!;
    // Outlier dropped — mean stays near 5, not skewed by 10000
    expect(baseline.mean[0]).toBeCloseTo(5);
  });
});

function filled(n: number, v: number): number[] {
  return Array.from({ length: n }, () => v);
}
