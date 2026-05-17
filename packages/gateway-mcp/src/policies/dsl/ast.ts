/**
 * Compile a validated PolicyDsl document into a runtime-friendly form.
 *
 * The compile step:
 *   - Validates against PolicyDslSchema (Zod) — caller may also pre-validate.
 *   - Pre-compiles every `matches: <regex>` into a real RegExp once.
 *   - Enforces unique rule names.
 *   - Returns a CompiledDsl that the evaluator walks (no further parsing).
 *
 * Caching compiled regex matters: rules are evaluated on the hot path of
 * /api/v1/check, and a fresh `new RegExp()` per call would dominate.
 */

import {
  Condition,
  PolicyDsl,
  PolicyDslSchema,
  Rule,
} from '@agentguard/core-schema';

export interface CompiledRule {
  name: string;
  when?: CompiledCondition;
  then: Rule['then'];
}

export type CompiledCondition =
  | { kind: 'all'; children: CompiledCondition[] }
  | { kind: 'any'; children: CompiledCondition[] }
  | { kind: 'not'; child: CompiledCondition }
  | { kind: 'field'; checks: FieldCheck[] };

export interface FieldCheck {
  path: string[];
  op:
    | { kind: 'eq'; value: unknown }
    | { kind: 'ne'; value: unknown }
    | { kind: 'gt'; value: number }
    | { kind: 'lt'; value: number }
    | { kind: 'gte'; value: number }
    | { kind: 'lte'; value: number }
    | { kind: 'in'; values: unknown[] }
    | { kind: 'matches'; regex: RegExp; source: string };
}

export interface CompiledDsl {
  rules: CompiledRule[];
}

export class DslCompileError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DslCompileError';
  }
}

export function compileDsl(input: unknown): CompiledDsl {
  const parsed = PolicyDslSchema.safeParse(input);
  if (!parsed.success) {
    throw new DslCompileError('Invalid DSL document', parsed.error);
  }
  return compileValidated(parsed.data);
}

export function compileValidated(dsl: PolicyDsl): CompiledDsl {
  const seenNames = new Set<string>();
  const rules: CompiledRule[] = [];

  for (const rule of dsl.rules) {
    if (seenNames.has(rule.name)) {
      throw new DslCompileError(`Duplicate rule name: ${rule.name}`);
    }
    seenNames.add(rule.name);

    rules.push({
      name: rule.name,
      when: rule.when ? compileCondition(rule.when, `${rule.name}.when`) : undefined,
      then: rule.then,
    });
  }

  return { rules };
}

function compileCondition(cond: Condition, ctx: string): CompiledCondition {
  if (isPlainObject(cond)) {
    if ('all' in cond && Array.isArray((cond as any).all)) {
      return {
        kind: 'all',
        children: (cond as any).all.map((c: Condition, i: number) =>
          compileCondition(c, `${ctx}.all[${i}]`),
        ),
      };
    }
    if ('any' in cond && Array.isArray((cond as any).any)) {
      return {
        kind: 'any',
        children: (cond as any).any.map((c: Condition, i: number) =>
          compileCondition(c, `${ctx}.any[${i}]`),
        ),
      };
    }
    if ('not' in cond && (cond as any).not !== undefined) {
      return {
        kind: 'not',
        child: compileCondition((cond as any).not as Condition, `${ctx}.not`),
      };
    }

    // Field-comparator object: { "classifier.category": "shell", "anomaly.score": { ">": 0.7 } }
    const entries = Object.entries(cond as Record<string, unknown>);
    if (entries.length === 0) {
      throw new DslCompileError(`Empty condition at ${ctx}`);
    }
    const checks: FieldCheck[] = entries.map(([pathStr, comparator]) => ({
      path: pathStr.split('.').filter(Boolean),
      op: compileComparator(comparator, `${ctx}.${pathStr}`),
    }));
    return { kind: 'field', checks };
  }
  throw new DslCompileError(`Unsupported condition shape at ${ctx}`);
}

function compileComparator(value: unknown, ctx: string): FieldCheck['op'] {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return { kind: 'eq', value };
  }
  if (!isPlainObject(value)) {
    throw new DslCompileError(`Bad comparator at ${ctx}`);
  }
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    throw new DslCompileError(`Comparator must have exactly one operator at ${ctx}`);
  }
  const [op, arg] = entries[0];
  switch (op) {
    case '==':
      return { kind: 'eq', value: arg };
    case '!=':
      return { kind: 'ne', value: arg };
    case '>':
      assertNumber(arg, ctx);
      return { kind: 'gt', value: arg as number };
    case '<':
      assertNumber(arg, ctx);
      return { kind: 'lt', value: arg as number };
    case '>=':
      assertNumber(arg, ctx);
      return { kind: 'gte', value: arg as number };
    case '<=':
      assertNumber(arg, ctx);
      return { kind: 'lte', value: arg as number };
    case 'in':
      if (!Array.isArray(arg)) {
        throw new DslCompileError(`'in' operand must be an array at ${ctx}`);
      }
      return { kind: 'in', values: arg };
    case 'matches': {
      if (typeof arg !== 'string') {
        throw new DslCompileError(`'matches' operand must be a string at ${ctx}`);
      }
      try {
        const regex = new RegExp(arg);
        return { kind: 'matches', regex, source: arg };
      } catch (err) {
        throw new DslCompileError(
          `Invalid regex at ${ctx}: ${(err as Error).message}`,
        );
      }
    }
    default:
      throw new DslCompileError(`Unknown operator '${op}' at ${ctx}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertNumber(v: unknown, ctx: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new DslCompileError(`Operand at ${ctx} must be a finite number`);
  }
}
