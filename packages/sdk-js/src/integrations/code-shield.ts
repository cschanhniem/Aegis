/**
 * CodeShield helper — hits the gateway's `/api/v1/code-shield/scan`
 * endpoint and buffers the result so the SDK's auto-instrumentation
 * splices it into the next `/check` call for the same agent.
 *
 * Mirrors the Python helper API.
 */

import { record } from './code-shield-state.js';

export type CodeShieldLanguage = 'any' | 'python' | 'javascript' | 'shell' | 'sql';

export const LANGUAGES: readonly CodeShieldLanguage[] = [
  'any',
  'python',
  'javascript',
  'shell',
  'sql',
] as const;

export interface CodeShieldFinding {
  rule: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  language: CodeShieldLanguage;
  line: number;
  column: number;
  snippet: string;
  cwe?: string;
}

export interface CodeShieldResult {
  worst: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  findings: CodeShieldFinding[];
  unique_findings: number;
  scanned_chars: number;
  latency_ms: number;
}

export interface ScanOptions {
  code: string;
  language?: CodeShieldLanguage;
  agentId?: string;
  gatewayUrl?: string;
  apiKey?: string;
  disabledRules?: readonly string[];
  timeoutMs?: number;
  /** If false, don't buffer for the next /check call. Default true. */
  recordForCheck?: boolean;
}

export async function scan(opts: ScanOptions): Promise<CodeShieldResult> {
  const {
    code,
    language = 'any',
    agentId,
    gatewayUrl = 'http://localhost:8080',
    apiKey,
    disabledRules,
    timeoutMs = 5_000,
    recordForCheck = true,
  } = opts;

  if (!LANGUAGES.includes(language)) {
    throw new Error(`language must be one of ${LANGUAGES.join(', ')}; got ${language}`);
  }

  const body: Record<string, unknown> = { code, language };
  if (agentId) body.agent_id = agentId;
  if (disabledRules && disabledRules.length) body.disabled_rules = disabledRules;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = apiKey ?? (typeof process !== 'undefined' ? process.env?.AEGIS_API_KEY : undefined);
  if (key) headers['X-API-Key'] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/api/v1/code-shield/scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`code-shield scan failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
    const result = (await res.json()) as CodeShieldResult;
    if (recordForCheck && agentId) {
      record(agentId, result as unknown as Record<string, unknown>);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export { consume as consumeBuffer } from './code-shield-state.js';
