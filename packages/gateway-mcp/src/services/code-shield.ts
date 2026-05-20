/**
 * CodeShield — fast, local-only static checks for code that an agent
 * is about to commit, exec, or hand back to a user.
 *
 * Inspired by Meta LlamaFirewall's CodeShield component, but kept
 * deliberately small: a curated set of high-precision regex rules
 * that catch the well-known "agent generated dangerous code"
 * patterns. No subprocess to Semgrep, no LLM round-trip — runs in
 * sub-millisecond on every scan.
 *
 * Each rule encodes:
 *   - id           — stable identifier (used by the DSL evaluator,
 *                    audit log, and rule disable list)
 *   - severity     — LOW / MEDIUM / HIGH / CRITICAL
 *   - language     — 'any' | 'python' | 'javascript' | 'shell' | 'sql'
 *   - regex        — must capture the matching span
 *   - description  — human-readable summary
 *   - cwe          — optional CWE identifier for audit reporting
 *
 * Out of scope (intentional for v0.3.0):
 *   - dataflow tracing (taint analysis)
 *   - AST-aware passes — false-positive cost is higher than the
 *     value at this stage
 *   - language detection — caller passes language hint, default 'any'
 */

import type { Logger } from 'pino';

export type CodeShieldSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type CodeShieldLanguage =
  | 'any'
  | 'python'
  | 'javascript'
  | 'shell'
  | 'sql';

export interface CodeShieldRule {
  id: string;
  description: string;
  severity: CodeShieldSeverity;
  language: CodeShieldLanguage;
  regex: RegExp;
  cwe?: string;
}

export interface CodeShieldFinding {
  rule: string;
  description: string;
  severity: CodeShieldSeverity;
  language: CodeShieldLanguage;
  line: number;
  column: number;
  /** 80-char window centered on the match. */
  snippet: string;
  cwe?: string;
}

export interface CodeShieldResult {
  /** Highest severity observed across all findings. null if clean. */
  worst: CodeShieldSeverity | null;
  findings: CodeShieldFinding[];
  /** Number of findings deduplicated to the unique (rule, line) pair. */
  unique_findings: number;
  scanned_chars: number;
  latency_ms: number;
}

// ── Rule catalog ────────────────────────────────────────────────────────────

export const DEFAULT_RULES: CodeShieldRule[] = [
  // ── Python ─────────────────────────────────────────────────────────────────
  {
    id: 'py.exec',
    description: 'Use of `exec(...)` — arbitrary code execution',
    severity: 'CRITICAL',
    language: 'python',
    regex: /\bexec\s*\(/g,
    cwe: 'CWE-95',
  },
  {
    id: 'py.eval',
    description: 'Use of `eval(...)` — arbitrary expression evaluation',
    severity: 'CRITICAL',
    language: 'python',
    regex: /\beval\s*\(/g,
    cwe: 'CWE-95',
  },
  {
    id: 'py.os.system',
    description: 'Use of `os.system(...)` — shell command execution',
    severity: 'HIGH',
    language: 'python',
    regex: /\bos\s*\.\s*system\s*\(/g,
    cwe: 'CWE-78',
  },
  {
    id: 'py.subprocess.shell',
    description: 'subprocess call with shell=True — command injection vector',
    severity: 'HIGH',
    language: 'python',
    regex: /subprocess\.[A-Za-z_]+\([^)]*shell\s*=\s*True/g,
    cwe: 'CWE-78',
  },
  {
    id: 'py.pickle.loads',
    description: '`pickle.loads(...)` on untrusted input deserializes arbitrary code',
    severity: 'HIGH',
    language: 'python',
    regex: /\bpickle\s*\.\s*loads?\s*\(/g,
    cwe: 'CWE-502',
  },

  // ── JavaScript / TypeScript ───────────────────────────────────────────────
  {
    id: 'js.eval',
    description: 'Use of `eval(...)` — arbitrary code execution',
    severity: 'CRITICAL',
    language: 'javascript',
    regex: /\beval\s*\(/g,
    cwe: 'CWE-95',
  },
  {
    id: 'js.new-function',
    description: '`new Function(...)` constructs and runs arbitrary code',
    severity: 'CRITICAL',
    language: 'javascript',
    regex: /\bnew\s+Function\s*\(/g,
    cwe: 'CWE-95',
  },
  {
    id: 'js.child_process.exec',
    description: 'child_process.exec(...) — shell command execution',
    severity: 'HIGH',
    language: 'javascript',
    regex: /child_process\s*\.\s*(?:exec|execSync)\s*\(/g,
    cwe: 'CWE-78',
  },
  {
    id: 'js.innerHTML',
    description: 'innerHTML assignment from a variable — DOM-based XSS risk',
    severity: 'MEDIUM',
    language: 'javascript',
    regex: /\.innerHTML\s*=\s*[A-Za-z_$]/g,
    cwe: 'CWE-79',
  },

  // ── Shell ─────────────────────────────────────────────────────────────────
  {
    id: 'sh.rm-rf-root',
    description: 'Recursive force-remove anchored at root or $HOME',
    severity: 'CRITICAL',
    language: 'shell',
    regex: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|\$HOME|~)/g,
    cwe: 'CWE-78',
  },
  {
    id: 'sh.curl-pipe-sh',
    description: 'curl ... | sh — fetching and executing untrusted script',
    severity: 'HIGH',
    language: 'shell',
    regex: /\bcurl\s+[^|;&]*\|\s*(?:bash|sh|zsh)\b/g,
    cwe: 'CWE-494',
  },
  {
    id: 'sh.sudo',
    description: 'sudo invocation — privilege escalation',
    severity: 'MEDIUM',
    language: 'shell',
    regex: /(^|\s)sudo\s+/g,
    cwe: 'CWE-269',
  },

  // ── SQL ──────────────────────────────────────────────────────────────────
  {
    id: 'sql.drop-table',
    description: 'DROP TABLE — destructive schema change',
    severity: 'HIGH',
    language: 'sql',
    regex: /\bDROP\s+TABLE\b/gi,
    cwe: 'CWE-89',
  },
  {
    id: 'sql.delete-no-where',
    description: 'DELETE FROM without a WHERE clause — full-table wipe',
    severity: 'HIGH',
    language: 'sql',
    regex: /\bDELETE\s+FROM\s+\w+(?!\s+WHERE)\s*(?:;|$)/gi,
    cwe: 'CWE-89',
  },

  // ── Cross-language secrets ────────────────────────────────────────────────
  {
    id: 'secret.aws-access-key',
    description: 'Hardcoded AWS access key ID',
    severity: 'CRITICAL',
    language: 'any',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    cwe: 'CWE-798',
  },
  {
    id: 'secret.openai-key',
    description: 'Hardcoded OpenAI API key',
    severity: 'CRITICAL',
    language: 'any',
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    cwe: 'CWE-798',
  },
  {
    id: 'secret.anthropic-key',
    description: 'Hardcoded Anthropic API key',
    severity: 'CRITICAL',
    language: 'any',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    cwe: 'CWE-798',
  },
  {
    id: 'secret.github-token',
    description: 'Hardcoded GitHub token',
    severity: 'CRITICAL',
    language: 'any',
    regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    cwe: 'CWE-798',
  },
  {
    id: 'secret.private-key',
    description: 'PEM private key material',
    severity: 'CRITICAL',
    language: 'any',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
    cwe: 'CWE-798',
  },
];

const SEVERITY_RANK: Record<CodeShieldSeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function worstOf(
  a: CodeShieldSeverity | null,
  b: CodeShieldSeverity,
): CodeShieldSeverity {
  if (!a) return b;
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function snippetAt(code: string, start: number, end: number): string {
  const before = Math.max(0, start - 30);
  const after = Math.min(code.length, end + 30);
  const raw = code.slice(before, after).replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? raw.slice(0, 77) + '…' : raw;
}

function lineColAt(code: string, offset: number): { line: number; column: number } {
  // 1-based line/col. We don't optimize this with a prefix array — the
  // scan is O(rules × matches × code) anyway and code is short.
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, column: col };
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface CodeShieldOptions {
  /** Restrict the rule set to a given language plus 'any' rules. */
  language?: CodeShieldLanguage;
  /** Disable specific rule IDs (e.g. ["sh.sudo"]). */
  disabledRules?: string[];
  /** Override rule catalog entirely. */
  rules?: CodeShieldRule[];
}

export class CodeShield {
  private rules: CodeShieldRule[];

  constructor(
    private logger: Logger | undefined,
    rules: CodeShieldRule[] = DEFAULT_RULES,
  ) {
    this.rules = rules;
  }

  scan(code: string, opts: CodeShieldOptions = {}): CodeShieldResult {
    const started = Date.now();
    const lang = opts.language ?? 'any';
    const disabled = new Set(opts.disabledRules ?? []);
    const ruleSet = (opts.rules ?? this.rules).filter((r) => {
      if (disabled.has(r.id)) return false;
      if (lang === 'any') return true;
      return r.language === 'any' || r.language === lang;
    });

    const findings: CodeShieldFinding[] = [];
    let worst: CodeShieldSeverity | null = null;
    const seen = new Set<string>();

    for (const rule of ruleSet) {
      // Each scan must start the regex from 0 since we share rule
      // objects across requests. Reset lastIndex defensively.
      rule.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.regex.exec(code)) !== null) {
        const { line, column } = lineColAt(code, m.index);
        const key = `${rule.id}:${line}`;
        if (seen.has(key)) {
          // Same rule, same line — only report once. Prevent regex
          // global loops from re-reporting on overlapping matches.
          if (m.index === rule.regex.lastIndex) rule.regex.lastIndex += 1;
          continue;
        }
        seen.add(key);
        findings.push({
          rule: rule.id,
          description: rule.description,
          severity: rule.severity,
          language: rule.language,
          line,
          column,
          snippet: snippetAt(code, m.index, m.index + m[0].length),
          cwe: rule.cwe,
        });
        worst = worstOf(worst, rule.severity);
        // Defensive guard against zero-width matches looping forever.
        if (m.index === rule.regex.lastIndex) rule.regex.lastIndex += 1;
      }
    }

    return {
      worst,
      findings,
      unique_findings: seen.size,
      scanned_chars: code.length,
      latency_ms: Date.now() - started,
    };
  }
}
