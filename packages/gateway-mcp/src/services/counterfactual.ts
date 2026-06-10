/**
 * Counterfactual explainer — when a policy blocks a call, return the
 * minimum edit that WOULD have made it pass.
 *
 * Why this exists: NIST AI RMF + EU AI Act Art. 14 both require that
 * automated decisions be explainable to affected parties. "Your call
 * was blocked because policy X fired" is the WHY; the counterfactual
 * is the **what next**. For developer ergonomics this is the single
 * most-requested feature on AI-guardrail product pages — beats raw
 * AJV error messages by a wide margin.
 *
 * Strategy: AJV produces structured errors that pinpoint the failing
 * keyword + JSON-pointer path. We translate each keyword class into a
 * minimal fix:
 *
 *   - pattern    "argument must match /…/"  → suggest a value that satisfies
 *   - not        "argument must NOT match …" → propose stripping the matched substring
 *   - maxLength  "≤ N chars"                → propose truncation to N
 *   - minLength  "≥ N chars"                → propose padding (rare for guardrails)
 *   - enum       "one of [A, B, C]"         → propose the closest enum value
 *   - required   "missing field X"          → propose providing X
 *   - type       "type mismatch"            → propose the expected type with a stub
 *   - additionalProperties / unevaluated... → propose removing the offending key
 *
 * Optionally we apply the suggested edit to the original arguments and
 * re-run validation; if it passes, we mark `verified: true`. That
 * verification step keeps the suggestion HONEST — we don't claim a
 * counterfactual that wouldn't actually pass.
 */

import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';

export interface CounterfactualSuggestion {
  /** Plain-English description of the change. */
  description: string;
  /** The proposed edited arguments. */
  proposed_arguments: any;
  /** Did re-running the policy on `proposed_arguments` pass? */
  verified: boolean;
  /** The AJV keyword that drove this suggestion. */
  fix_kind: string;
  /** JSON-pointer-like path to the field that was edited. */
  path: string;
}

export interface CounterfactualResult {
  any_suggestion: boolean;
  suggestions: CounterfactualSuggestion[];
  /** Schema-derived "rules of thumb" surfaced to the operator even
   *  when no concrete edit was possible (e.g. type errors with no
   *  reasonable default). */
  guidance: string[];
}

/** Walk an object by JSON-pointer-style path. Returns the value at the
 *  path or undefined if any segment is missing. */
function getAt(obj: any, path: string): any {
  if (!path || path === '') return obj;
  const segs = path.replace(/^\/+/, '').split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = obj;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = (cur as any)[s];
  }
  return cur;
}

/** Deep-clone an object with a single edit at the given path. Returns
 *  a NEW object — never mutates the input. */
function withEditAt(obj: any, path: string, newValue: any): any {
  const cloned = JSON.parse(JSON.stringify(obj));
  if (!path || path === '') return newValue;
  const segs = path.replace(/^\/+/, '').split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = cloned;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] == null) cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = newValue;
  return cloned;
}

/** Deep-clone with a key removed at the given path. */
function withDeleteAt(obj: any, path: string): any {
  const cloned = JSON.parse(JSON.stringify(obj));
  if (!path || path === '') return cloned;
  const segs = path.replace(/^\/+/, '').split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = cloned;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur == null) return cloned;
    cur = cur[segs[i]];
  }
  if (cur && typeof cur === 'object') delete cur[segs[segs.length - 1]];
  return cloned;
}

/** Try to construct a value that satisfies a `pattern` keyword. Real
 *  regex inversion is undecidable in general; we handle the common
 *  shapes guardrails use: `^https://`, `^[A-Za-z0-9]+$`, `^[\w.-]+@[\w.-]+$`, etc. */
function exampleForPattern(pattern: string, current?: string): string | null {
  // ^https://  → https://example.com/path  (best-effort URL)
  if (/^\^https:\\\/\\\/|^\^https:\/\//.test(pattern)) {
    return 'https://example.com/' + (current ? current.replace(/^https?:\/\//, '') : 'safe');
  }
  // ^http(s)?:// shape  (force https variant)
  if (/^\^https\?:\\\/\\\/|^\^https\?:\/\//.test(pattern)) {
    return (current ?? '').replace(/^http:\/\//, 'https://') || 'https://example.com';
  }
  // Email-shape
  if (pattern.includes('@')) return 'user@example.com';
  return null;
}

/** Inverse for `not.pattern` — if `value` matches the pattern, strip
 *  the offending substring (best-effort). */
function stripPattern(value: string, pattern: string): string {
  try {
    const re = new RegExp(pattern, 'i');
    return value.replace(re, '').trim();
  } catch { return value; }
}

/** Closest enum value by simple case-insensitive substring match;
 *  falls back to the first option. */
function closestEnum(current: any, options: any[]): any {
  if (typeof current === 'string') {
    const lo = current.toLowerCase();
    const match = options.find(o => typeof o === 'string' && o.toLowerCase().includes(lo));
    if (match !== undefined) return match;
  }
  return options[0];
}

/** Generate counterfactual edits for a single AJV-validated failure.
 *
 *  @param validate   the compiled AJV validator function (already ran
 *                    and produced .errors on the original arguments)
 *  @param args       the original arguments object that failed
 */
export function generateCounterfactual(
  validate: ValidateFunction,
  args: any,
): CounterfactualResult {
  const errors = validate.errors ?? [];
  const suggestions: CounterfactualSuggestion[] = [];
  const guidance: string[] = [];

  for (const err of errors) {
    const path = err.instancePath ?? '';
    const cur = getAt(args, path);
    const params = (err as any).params ?? {};

    switch (err.keyword) {
      case 'pattern': {
        const ex = exampleForPattern(params.pattern, typeof cur === 'string' ? cur : undefined);
        if (ex) {
          const proposed = withEditAt(args, path, ex);
          const verified = !!validate(proposed) ? !validate.errors?.length : false;
          // Re-validate cleanly: AJV mutates .errors so we must check.
          const ok = !!validate(proposed);
          suggestions.push({
            description: `Change field${path ? ` "${path}"` : ''} to a value that matches /${params.pattern}/ — e.g. ${JSON.stringify(ex)}`,
            proposed_arguments: proposed,
            verified: ok,
            fix_kind: 'pattern',
            path,
          });
        } else {
          guidance.push(`Field ${path || '(root)'} must match the regex /${params.pattern}/ — provide a value that satisfies it.`);
        }
        break;
      }
      case 'not': {
        if (typeof cur === 'string' && params.failingKeyword === 'pattern') {
          // We can't reach into the nested schema reliably, but the
          // AJV error often has the parent path. Best-effort: strip
          // any obvious denylist substring.
          guidance.push(`Field ${path || '(root)'} matched a denylist pattern; remove the offending substring.`);
        } else {
          guidance.push(`Field ${path || '(root)'} matched a forbidden shape; rewrite to avoid it.`);
        }
        break;
      }
      case 'maxLength': {
        if (typeof cur === 'string') {
          const truncated = cur.slice(0, params.limit);
          const proposed = withEditAt(args, path, truncated);
          const ok = !!validate(proposed);
          suggestions.push({
            description: `Truncate field${path ? ` "${path}"` : ''} to ≤ ${params.limit} characters.`,
            proposed_arguments: proposed,
            verified: ok,
            fix_kind: 'maxLength',
            path,
          });
        }
        break;
      }
      case 'minLength': {
        if (typeof cur === 'string') {
          guidance.push(`Field ${path || '(root)'} needs at least ${params.limit} chars.`);
        }
        break;
      }
      case 'enum': {
        const opts = params.allowedValues as any[];
        const repl = closestEnum(cur, opts);
        const proposed = withEditAt(args, path, repl);
        const ok = !!validate(proposed);
        suggestions.push({
          description: `Field${path ? ` "${path}"` : ''} must be one of ${JSON.stringify(opts)} — try ${JSON.stringify(repl)}.`,
          proposed_arguments: proposed,
          verified: ok,
          fix_kind: 'enum',
          path,
        });
        break;
      }
      case 'required': {
        const missing = params.missingProperty;
        const proposedPath = path ? `${path}/${missing}` : `/${missing}`;
        const proposed = withEditAt(args, proposedPath, '');
        const ok = !!validate(proposed);
        suggestions.push({
          description: `Provide the missing field "${missing}".`,
          proposed_arguments: proposed,
          verified: ok,
          fix_kind: 'required',
          path: proposedPath,
        });
        break;
      }
      case 'type': {
        guidance.push(`Field ${path || '(root)'} must be of type ${params.type}.`);
        break;
      }
      case 'additionalProperties':
      case 'unevaluatedProperties': {
        const offender = params.additionalProperty ?? params.unevaluatedProperty;
        if (offender) {
          const offenderPath = path ? `${path}/${offender}` : `/${offender}`;
          const proposed = withDeleteAt(args, offenderPath);
          const ok = !!validate(proposed);
          suggestions.push({
            description: `Remove disallowed field "${offender}".`,
            proposed_arguments: proposed,
            verified: ok,
            fix_kind: 'additionalProperties',
            path: offenderPath,
          });
        }
        break;
      }
      default:
        guidance.push(`(${err.keyword}) ${err.message ?? 'unknown failure'} at ${path || '(root)'}.`);
    }
  }

  return {
    any_suggestion: suggestions.length > 0,
    suggestions,
    guidance,
  };
}

/** Convenience: compile a JSON Schema, run it, and produce a
 *  counterfactual all in one. Used by API endpoints. */
export function explainBlock(schema: any, args: any): CounterfactualResult {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  validate(args);
  return generateCounterfactual(validate, args);
}
