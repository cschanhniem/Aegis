/**
 * SCIM 2.0 filter parser (RFC 7644 §3.4.2.2).
 *
 * Why we hand-roll this: SCIM filter syntax is small (4 logical ops,
 * 10 comparison ops, parenthesised grouping) and using a generic SQL
 * builder would bloat the dep tree + give attack surface. The parser
 * compiles the filter into a SAFE { whereClause, params } pair that
 * the SCIM service feeds into better-sqlite3 — never string-interpolated
 * into SQL.
 *
 * Supported (mirrors Okta + Azure AD + JumpCloud client usage):
 *
 *   - Attribute paths: userName, emails, emails.value, name.familyName,
 *     active, externalId
 *   - Comparison ops: eq, ne, co (contains), sw (startsWith), ew (endsWith),
 *     pr (present), gt, ge, lt, le
 *   - Logical ops:    and, or, not
 *   - Grouping:       (…)
 *
 * Out of scope (we throw on encounter):
 *
 *   - Complex multi-valued attribute filters with nested predicates:
 *     `emails[type eq "work" and value co "@acme"]`  → 400 with a
 *     descriptive error. Real IdPs almost never emit this; falling
 *     back to a clean error beats silently mis-implementing.
 *   - Filtering by schemas[]  (not used by major IdPs in PATCH/GET)
 *
 * Mapping from SCIM attribute path → DB column lives in scim-service.ts;
 * this parser stays storage-agnostic so the same parser is reusable for
 * the Groups resource type.
 */

export type FilterAst =
  | { type: 'comparison'; attr: string; op: ComparisonOp; value: string | number | boolean | null }
  | { type: 'present'; attr: string }
  | { type: 'and'; left: FilterAst; right: FilterAst }
  | { type: 'or';  left: FilterAst; right: FilterAst }
  | { type: 'not'; inner: FilterAst };

export type ComparisonOp = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le';

const COMPARISON_OPS: ReadonlySet<string> = new Set(['eq','ne','co','sw','ew','gt','ge','lt','le']);

class Tokenizer {
  private i = 0;
  constructor(private readonly src: string) {}

  peek(): string | null {
    this.skipWs();
    return this.i < this.src.length ? this.src[this.i] : null;
  }

  done(): boolean { this.skipWs(); return this.i >= this.src.length; }

  private skipWs(): void { while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++; }

  /** Read the next bare word (attribute name or operator). */
  word(): string {
    this.skipWs();
    const start = this.i;
    while (this.i < this.src.length && /[A-Za-z0-9_.$:-]/.test(this.src[this.i])) this.i++;
    if (start === this.i) throw new Error(`expected word at position ${this.i}`);
    return this.src.slice(start, this.i);
  }

  /** Read a quoted string literal — backslash escapes for " and \. */
  string(): string {
    this.skipWs();
    if (this.src[this.i] !== '"') throw new Error(`expected " at position ${this.i}`);
    this.i++;
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i++];
      if (c === '"') return out;
      if (c === '\\' && this.i < this.src.length) { out += this.src[this.i++]; continue; }
      out += c;
    }
    throw new Error('unterminated string literal');
  }

  /** Try to consume an exact bareword (case-insensitive). Returns true on success. */
  consume(word: string): boolean {
    this.skipWs();
    if (this.src.slice(this.i, this.i + word.length).toLowerCase() === word.toLowerCase()
        && !/[A-Za-z0-9_]/.test(this.src[this.i + word.length] ?? '')) {
      this.i += word.length;
      return true;
    }
    return false;
  }

  consumeChar(c: string): boolean {
    this.skipWs();
    if (this.src[this.i] === c) { this.i++; return true; }
    return false;
  }
}

/** Parse a SCIM filter string into an AST. */
export function parseScimFilter(src: string): FilterAst {
  const t = new Tokenizer(src);
  const ast = parseOr(t);
  if (!t.done()) throw new Error(`unexpected trailing input near position`);
  return ast;
}

function parseOr(t: Tokenizer): FilterAst {
  let left = parseAnd(t);
  while (t.consume('or')) {
    const right = parseAnd(t);
    left = { type: 'or', left, right };
  }
  return left;
}

function parseAnd(t: Tokenizer): FilterAst {
  let left = parseNot(t);
  while (t.consume('and')) {
    const right = parseNot(t);
    left = { type: 'and', left, right };
  }
  return left;
}

function parseNot(t: Tokenizer): FilterAst {
  if (t.consume('not')) {
    const inner = parsePrimary(t);
    return { type: 'not', inner };
  }
  return parsePrimary(t);
}

function parsePrimary(t: Tokenizer): FilterAst {
  if (t.consumeChar('(')) {
    const inner = parseOr(t);
    if (!t.consumeChar(')')) throw new Error('expected )');
    return inner;
  }
  const attr = t.word();
  if (attr.includes('[')) throw new Error('SCIM nested-value-filters (attr[...]) are not supported');
  const op = t.word().toLowerCase();
  if (op === 'pr') return { type: 'present', attr };
  if (!COMPARISON_OPS.has(op)) throw new Error(`unknown operator: ${op}`);
  let value: string | number | boolean | null;
  if (t.peek() === '"') value = t.string();
  else {
    const tok = t.word();
    if (tok === 'true')  value = true;
    else if (tok === 'false') value = false;
    else if (tok === 'null')  value = null;
    else if (/^-?\d+(\.\d+)?$/.test(tok)) value = Number(tok);
    else value = tok;
  }
  return { type: 'comparison', attr, op: op as ComparisonOp, value };
}

// ── AST → SQL ────────────────────────────────────────────────────────

export interface SqlFragment {
  where: string;
  params: any[];
}

/** Compile an AST into a parameterised SQL fragment. The caller
 *  supplies the attribute → column mapping so SCIM Users + Groups can
 *  share this function. Unknown attributes throw — refusing to invent
 *  a mapping is a defensive choice. */
export function astToSql(
  ast: FilterAst,
  attrMap: Record<string, string>,
): SqlFragment {
  switch (ast.type) {
    case 'and': {
      const a = astToSql(ast.left, attrMap);
      const b = astToSql(ast.right, attrMap);
      return { where: `(${a.where} AND ${b.where})`, params: [...a.params, ...b.params] };
    }
    case 'or': {
      const a = astToSql(ast.left, attrMap);
      const b = astToSql(ast.right, attrMap);
      return { where: `(${a.where} OR ${b.where})`, params: [...a.params, ...b.params] };
    }
    case 'not': {
      const inner = astToSql(ast.inner, attrMap);
      return { where: `NOT (${inner.where})`, params: inner.params };
    }
    case 'present': {
      const col = resolveAttr(ast.attr, attrMap);
      return { where: `${col} IS NOT NULL AND ${col} != ''`, params: [] };
    }
    case 'comparison': {
      const col = resolveAttr(ast.attr, attrMap);
      switch (ast.op) {
        case 'eq': return { where: `${col} = ?`,  params: [ast.value] };
        case 'ne': return { where: `${col} != ?`, params: [ast.value] };
        case 'co': return { where: `${col} LIKE ?`, params: [`%${escapeLike(String(ast.value))}%`] };
        case 'sw': return { where: `${col} LIKE ?`, params: [`${escapeLike(String(ast.value))}%`] };
        case 'ew': return { where: `${col} LIKE ?`, params: [`%${escapeLike(String(ast.value))}`] };
        case 'gt': return { where: `${col} > ?`,  params: [ast.value] };
        case 'ge': return { where: `${col} >= ?`, params: [ast.value] };
        case 'lt': return { where: `${col} < ?`,  params: [ast.value] };
        case 'le': return { where: `${col} <= ?`, params: [ast.value] };
      }
    }
  }
}

function resolveAttr(attr: string, map: Record<string, string>): string {
  // Case-insensitive lookup — SCIM attribute names are conventionally
  // camelCase but IdPs send mixed case.
  const k = Object.keys(map).find(k => k.toLowerCase() === attr.toLowerCase());
  if (!k) throw new Error(`attribute not filterable: ${attr}`);
  return map[k];
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => '\\' + c);
}
