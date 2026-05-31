/**
 * DeclarativeDetector — turns a CustomDetectorSpec (operator-supplied
 * JSON) into a runtime Detector. Per-tenant scoped: emits signals only
 * when the evaluation context's tenant.id matches the spec's owning org.
 *
 * Safety:
 *   • No code execution — purely AST evaluation over the match condition.
 *   • Regex source compiled once at construction; per-call evaluation
 *     bounded by registry-level per-detector timeout.
 *   • Regex inputs (tool name + flattened arg strings) are length-bounded
 *     to keep ReDoS surface small. Customers writing crazy patterns get
 *     timed out by the registry rather than hanging the whole chain.
 */

import {
  CustomDetectorSpec,
  Detector,
  DetectorContext,
  Signal,
  Severity,
} from '@agentguard/core-schema';

// Inputs longer than this are truncated before regex matching to bound
// the worst-case backtracking cost.
const MAX_STRING_INPUT = 16 * 1024;

interface CompiledAtomicMatch {
  kind: 'tool_name' | 'arg_string' | 'arg_path';
  re: RegExp;
  argPath?: string;
}

type CompiledCondition =
  | { kind: 'all'; children: CompiledCondition[] }
  | { kind: 'any'; children: CompiledCondition[] }
  | { kind: 'not'; child: CompiledCondition }
  | CompiledAtomicMatch;

interface CompiledRule {
  when?: CompiledCondition;
  emit: {
    severity: Severity;
    category: string;
    message: string;
    ontology?: ReadonlyArray<string>;
  };
}

function compileCondition(node: any): CompiledCondition {
  if ('all' in node) return { kind: 'all', children: node.all.map(compileCondition) };
  if ('any' in node) return { kind: 'any', children: node.any.map(compileCondition) };
  if ('not' in node) return { kind: 'not', child: compileCondition(node.not) };
  if ('tool_name_pattern' in node) {
    return { kind: 'tool_name', re: new RegExp(node.tool_name_pattern) };
  }
  if ('arg_string_pattern' in node) {
    return { kind: 'arg_string', re: new RegExp(node.arg_string_pattern) };
  }
  if ('arg_path_pattern' in node && 'arg_path' in node) {
    return { kind: 'arg_path', re: new RegExp(node.arg_path_pattern), argPath: node.arg_path };
  }
  throw new Error(`unrecognized match clause: ${JSON.stringify(node).slice(0, 80)}`);
}

function flatStringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 256) return out;
  if (typeof node === 'string') {
    out.push(node.length > MAX_STRING_INPUT ? node.slice(0, MAX_STRING_INPUT) : node);
  } else if (Array.isArray(node)) {
    for (const v of node) flatStringValues(v, out, depth + 1);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) flatStringValues(v, out, depth + 1);
  }
  return out;
}

function dottedGet(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function evalCondition(cond: CompiledCondition, ctx: DetectorContext, flatArgs: string[]): boolean {
  switch (cond.kind) {
    case 'all': return cond.children.every(c => evalCondition(c, ctx, flatArgs));
    case 'any': return cond.children.some(c => evalCondition(c, ctx, flatArgs));
    case 'not': return !evalCondition(cond.child, ctx, flatArgs);
    case 'tool_name': return cond.re.test(ctx.tool.name);
    case 'arg_string': return flatArgs.some(s => cond.re.test(s));
    case 'arg_path': {
      const v = dottedGet(ctx.tool.args, cond.argPath!);
      if (v == null) return false;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const bounded = s.length > MAX_STRING_INPUT ? s.slice(0, MAX_STRING_INPUT) : s;
      return cond.re.test(bounded);
    }
  }
}

export class DeclarativeDetector implements Detector {
  readonly name: string;
  readonly version: string;
  readonly kind: 'content' | 'classify' | 'behavior' | 'meta';
  readonly coverage: ReadonlyArray<string>;
  private readonly orgId: string;
  private readonly enabled: boolean;
  private readonly compiledRules: CompiledRule[];

  constructor(orgId: string, spec: CustomDetectorSpec) {
    this.orgId   = orgId;
    this.name    = `tenant.${orgId}.${spec.name}`;
    this.version = spec.version;
    this.kind    = spec.kind;
    this.coverage = spec.coverage;
    this.enabled = spec.enabled;
    this.compiledRules = spec.rules.map(r => ({
      when: r.when ? compileCondition(r.when) : undefined,
      emit: {
        severity: r.emit.severity,
        category: r.emit.category,
        message: r.emit.message,
        ontology: r.emit.ontology,
      },
    }));
  }

  evaluate(ctx: DetectorContext): Signal[] {
    // Per-tenant scoping — a custom detector registered by org A must
    // never fire on org B's requests, even though both share the same
    // DetectorRegistry instance.
    if (!this.enabled) return [];
    if (ctx.tenant.id !== this.orgId) return [];

    const flatArgs = flatStringValues(ctx.tool.args);
    const out: Signal[] = [];
    for (const rule of this.compiledRules) {
      const matched = !rule.when || evalCondition(rule.when, ctx, flatArgs);
      if (!matched) continue;
      out.push({
        detector: this.name,
        version: this.version,
        severity: rule.emit.severity,
        category: rule.emit.category,
        message: rule.emit.message,
        evidence: { tool: ctx.tool.name, agent_id: ctx.agent.id },
        ontology: [...(rule.emit.ontology ?? this.coverage)],
      });
    }
    return out;
  }
}
