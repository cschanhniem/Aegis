/**
 * Policy DSL — compile, evaluate, service + ConfigBus integration.
 */
import Database from 'better-sqlite3';
import pino from 'pino';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { ConfigBus } from '../services/config-bus';
import { TenantConfigService } from '../services/tenant-config';
import { AuditLogService } from '../services/audit-log';
import { DslPolicyService } from '../services/policy-dsl';
import { compileDsl, DslCompileError } from '../policies/dsl/ast';
import {
  DslEvaluator,
  strictest,
  type DslContext,
} from '../policies/dsl/evaluator';

const silentLogger = pino({ level: 'silent' });

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS traces (trace_id TEXT PRIMARY KEY)`);
  initializeEnterpriseSchema(db);
  return db;
}

function makeStack() {
  const db = makeDb();
  const bus = new ConfigBus(silentLogger);
  const audit = new AuditLogService(db, silentLogger);
  const tenant = new TenantConfigService(db, silentLogger, bus, audit);
  tenant.seedDefaults();
  const dsl = new DslPolicyService(silentLogger, bus, tenant);
  dsl.warmCache(['default']);
  return { db, bus, audit, tenant, dsl };
}

// ── AST compile ──────────────────────────────────────────────────────────────

describe('compileDsl', () => {
  test('accepts a minimal valid document', () => {
    const compiled = compileDsl({
      version: 1,
      rules: [{ name: 'r1', then: { decision: 'allow' } }],
    });
    expect(compiled.rules).toHaveLength(1);
    expect(compiled.rules[0].name).toBe('r1');
  });

  test('rejects invalid Zod shape', () => {
    expect(() =>
      compileDsl({ version: 1, rules: [{ name: '', then: { decision: 'allow' } }] }),
    ).toThrow(DslCompileError);
  });

  test('rejects duplicate rule names', () => {
    expect(() =>
      compileDsl({
        version: 1,
        rules: [
          { name: 'a', then: { decision: 'allow' } },
          { name: 'a', then: { decision: 'block' } },
        ],
      }),
    ).toThrow(/Duplicate rule name/);
  });

  test('rejects invalid regex in matches', () => {
    expect(() =>
      compileDsl({
        version: 1,
        rules: [
          {
            name: 'bad-regex',
            when: { 'tool.name': { matches: '(' } },
            then: { decision: 'block' },
          },
        ],
      }),
    ).toThrow(/Invalid regex/);
  });

  test('compiles all combinators', () => {
    const compiled = compileDsl({
      version: 1,
      rules: [
        {
          name: 'complex',
          when: {
            all: [
              {
                any: [
                  { 'classifier.category': 'shell' },
                  { 'classifier.category': 'database' },
                ],
              },
              { not: { 'agent.id': 'trusted' } },
            ],
          },
          then: { decision: 'block' },
        },
      ],
    });
    expect(compiled.rules[0].when?.kind).toBe('all');
  });
});

// ── Evaluator ────────────────────────────────────────────────────────────────

function ev(rules: any[]): DslEvaluator {
  return new DslEvaluator(compileDsl({ version: 1, rules }));
}

describe('DslEvaluator', () => {
  const baseCtx: DslContext = {
    classifier: { category: 'network' },
    anomaly: { score: 0.4 },
    policy: { passed: true, riskLevel: 'LOW' },
    tool: { name: 'fetch', args: { url: 'https://example.com' } },
    agent: { id: 'agent-1' },
    tenant: { id: 'default', deploymentMode: 'standard' },
  };

  test('first matching rule wins', () => {
    const e = ev([
      {
        name: 'first',
        when: { 'classifier.category': 'network' },
        then: { decision: 'pending', reason: 'first' },
      },
      {
        name: 'second',
        when: { 'classifier.category': 'network' },
        then: { decision: 'block', reason: 'second' },
      },
    ]);
    const r = e.evaluate(baseCtx);
    expect(r?.ruleName).toBe('first');
    expect(r?.decision).toBe('pending');
  });

  test('no rule matches returns null', () => {
    const e = ev([
      {
        name: 'shell-only',
        when: { 'classifier.category': 'shell' },
        then: { decision: 'block' },
      },
    ]);
    expect(e.evaluate(baseCtx)).toBeNull();
  });

  test('rule without when always matches', () => {
    const e = ev([{ name: 'always', then: { decision: 'pending' } }]);
    expect(e.evaluate(baseCtx)?.decision).toBe('pending');
  });

  test('comparator: >, <, >=, <=', () => {
    expect(
      ev([
        {
          name: 'gt',
          when: { 'anomaly.score': { '>': 0.3 } },
          then: { decision: 'pending' },
        },
      ]).evaluate(baseCtx)?.decision,
    ).toBe('pending');

    expect(
      ev([
        {
          name: 'gt-high',
          when: { 'anomaly.score': { '>': 0.9 } },
          then: { decision: 'block' },
        },
      ]).evaluate(baseCtx),
    ).toBeNull();
  });

  test('comparator: in', () => {
    expect(
      ev([
        {
          name: 'in-list',
          when: { 'classifier.category': { in: ['shell', 'network', 'database'] } },
          then: { decision: 'pending' },
        },
      ]).evaluate(baseCtx)?.decision,
    ).toBe('pending');
  });

  test('comparator: matches', () => {
    expect(
      ev([
        {
          name: 'url-suspicious',
          when: { 'tool.args.url': { matches: 'evil\\.com' } },
          then: { decision: 'block' },
        },
      ]).evaluate({ ...baseCtx, tool: { name: 'fetch', args: { url: 'https://evil.com/x' } } })
        ?.decision,
    ).toBe('block');
  });

  test('all combinator (AND)', () => {
    const rule = {
      name: 'and',
      when: {
        all: [
          { 'classifier.category': 'network' },
          { 'anomaly.score': { '>': 0.3 } },
        ],
      },
      then: { decision: 'block' },
    };
    expect(ev([rule]).evaluate(baseCtx)?.decision).toBe('block');
    expect(
      ev([rule]).evaluate({ ...baseCtx, anomaly: { score: 0.1 } }),
    ).toBeNull();
  });

  test('any combinator (OR)', () => {
    const rule = {
      name: 'or',
      when: {
        any: [
          { 'classifier.category': 'shell' },
          { 'classifier.category': 'network' },
        ],
      },
      then: { decision: 'pending' },
    };
    expect(ev([rule]).evaluate(baseCtx)?.decision).toBe('pending');
  });

  test('not combinator', () => {
    expect(
      ev([
        {
          name: 'not-trusted',
          when: { not: { 'agent.id': 'agent-trusted' } },
          then: { decision: 'pending' },
        },
      ]).evaluate(baseCtx)?.decision,
    ).toBe('pending');
  });

  test('missing path resolves to undefined, never throws', () => {
    expect(
      ev([
        {
          name: 'missing',
          when: { 'classifier.zzz': 'x' },
          then: { decision: 'block' },
        },
      ]).evaluate(baseCtx),
    ).toBeNull();
  });

  test('deep tool.args access', () => {
    expect(
      ev([
        {
          name: 'deep',
          when: { 'tool.args.url': { matches: 'example' } },
          then: { decision: 'pending' },
        },
      ]).evaluate(baseCtx)?.decision,
    ).toBe('pending');
  });
});

// ── strictest helper ─────────────────────────────────────────────────────────

describe('strictest', () => {
  test('block > pending > allow', () => {
    expect(strictest('allow', 'pending')).toBe('pending');
    expect(strictest('pending', 'block')).toBe('block');
    expect(strictest('allow', 'block')).toBe('block');
    expect(strictest('allow', 'allow')).toBe('allow');
    expect(strictest('block', 'allow')).toBe('block');
  });
});

// ── DslPolicyService ─────────────────────────────────────────────────────────

describe('DslPolicyService', () => {
  test('returns null when tenant has no DSL', () => {
    const { dsl } = makeStack();
    expect(dsl.evaluate('default', {} as DslContext)).toBeNull();
  });

  test('hot-reloads when ConfigBus emits update', () => {
    const { dsl, tenant } = makeStack();
    tenant.update(
      'default',
      {
        dsl: {
          version: 1,
          rules: [{ name: 'block-net', when: { 'classifier.category': 'network' }, then: { decision: 'block' } }],
        },
      },
      {},
    );
    const r = dsl.evaluate('default', {
      classifier: { category: 'network' },
    } as DslContext);
    expect(r?.decision).toBe('block');

    // Replace with a different DSL
    tenant.update(
      'default',
      {
        dsl: {
          version: 1,
          rules: [{ name: 'pend-net', when: { 'classifier.category': 'network' }, then: { decision: 'pending' } }],
        },
      },
      {},
    );
    const r2 = dsl.evaluate('default', { classifier: { category: 'network' } } as DslContext);
    expect(r2?.decision).toBe('pending');
  });

  test('dryRun does not mutate cached evaluator', () => {
    const { dsl, tenant } = makeStack();
    tenant.update(
      'default',
      {
        dsl: {
          version: 1,
          rules: [{ name: 'baseline', when: { 'classifier.category': 'shell' }, then: { decision: 'block' } }],
        },
      },
      {},
    );
    // Dry-run with a totally different doc
    const result = dsl.dryRun(
      {
        version: 1,
        rules: [{ name: 'dry', when: { 'classifier.category': 'network' }, then: { decision: 'pending' } }],
      },
      { classifier: { category: 'network' } } as DslContext,
    );
    expect(result?.decision).toBe('pending');

    // Original evaluator still matches shell, not network
    expect(
      dsl.evaluate('default', { classifier: { category: 'network' } } as DslContext),
    ).toBeNull();
    expect(
      dsl.evaluate('default', { classifier: { category: 'shell' } } as DslContext)?.decision,
    ).toBe('block');
  });

  test('rule cap enforced (>100 rules rejected)', () => {
    const { tenant } = makeStack();
    const rules = Array.from({ length: 101 }, (_, i) => ({
      name: `r${i}`,
      then: { decision: 'allow' as const },
    }));
    expect(() =>
      tenant.update('default', { dsl: { version: 1, rules } as any }, {}),
    ).toThrow();
  });
});

// ── Performance smoke ───────────────────────────────────────────────────────

describe('Evaluator performance', () => {
  test('100 non-matching rules eval under 5ms', () => {
    const rules = Array.from({ length: 100 }, (_, i) => ({
      name: `miss-${i}`,
      when: { 'classifier.category': `nonexistent-${i}` },
      then: { decision: 'block' as const },
    }));
    const e = new DslEvaluator(compileDsl({ version: 1, rules }));
    const ctx = { classifier: { category: 'shell' } } as DslContext;

    // Warm up
    for (let i = 0; i < 1000; i++) e.evaluate(ctx);

    const N = 1000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) e.evaluate(ctx);
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
    const perEval = elapsed / N;
    expect(perEval).toBeLessThan(5);
  });
});
