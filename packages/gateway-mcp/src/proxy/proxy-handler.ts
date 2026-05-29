/**
 * LLM Egress Proxy handler — runs detector chain over every LLM exchange
 * that passes through. Provider-neutral: the adapter is responsible for
 * shape; the handler is responsible for security policy.
 *
 * v1 decision model (per pending tool_call):
 *   strictest signal across all detectors:
 *     critical  → block this tool call (response is mangled)
 *     warn      → log + audit, but pass through
 *     info      → log only
 *
 * v1.1 will fold in the DSL evaluator + AJV policy engine for parity with
 * `/api/v1/check`. The Signal contract is shared, so swapping the decision
 * function is the only change needed.
 */

import { Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { Logger } from 'pino';

import { Severity, Signal } from '@agentguard/core-schema';
import { DetectorRegistry } from '../detectors/registry';
import { AuditLogService } from '../services/audit-log';
import { calculateCost } from '../services/cost';
import {
  NeutralToolCall,
  ProxyAdapter,
} from './adapter';

const PROXY_PATH_RE = /^\/(openai|anthropic)(\/.*)$/;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

export interface ProxyHandlerDeps {
  db: Database.Database;
  logger: Logger;
  detectors: DetectorRegistry;
  audit: AuditLogService;
  adapters: ReadonlyArray<ProxyAdapter>;
}

interface AuthOk {
  orgId: string;
  keyName?: string;
  keyPrefix?: string;
}

export class ProxyHandler {
  private readonly byProvider: Map<string, ProxyAdapter>;

  constructor(private deps: ProxyHandlerDeps) {
    this.byProvider = new Map(deps.adapters.map(a => [a.provider, a]));
  }

  /** Express handler — mounted via app.all('/api/v1/proxy/*'). */
  handle = async (req: Request, res: Response): Promise<void> => {
    const path = req.path.replace(/^\/api\/v1\/llm-proxy/, '');
    const m = PROXY_PATH_RE.exec(path);
    if (!m) {
      res.status(404).json({ error: { code: 'UNKNOWN_PROVIDER', path } });
      return;
    }
    const provider = m[1];
    const tail = m[2];
    const adapter = this.byProvider.get(provider);
    if (!adapter) {
      res.status(404).json({ error: { code: 'PROVIDER_NOT_ENABLED', provider } });
      return;
    }

    const auth = this.checkAuth(req);
    if (!auth) {
      res.status(401).json({ error: { code: 'AEGIS_AUTH_MISSING', message: 'Missing or invalid X-AEGIS-Key header' } });
      return;
    }

    // Adapter-side preflight (streaming reject, etc.)
    const reject = adapter.preflightReject(req.body);
    if (reject) {
      res.status(400).json({ error: { code: 'PROXY_PREFLIGHT_REJECT', message: reject } });
      return;
    }

    const headers = lowerCaseHeaders(req.headers);
    const ctx = adapter.extractAegisContext(headers, req.body);

    // Forward upstream — BYO key model: customer's auth header passes through.
    const upstreamHeaders = adapter.upstreamHeaders(headers);
    const upstreamUrl = adapter.upstreamUrl(tail, queryStringFrom(req));
    const t0 = Date.now();
    let upstreamRes: Response | globalThis.Response;
    let upstreamJson: any;
    try {
      const fetchRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
      });
      upstreamRes = fetchRes;
      const text = await fetchRes.text();
      try { upstreamJson = JSON.parse(text); }
      catch { upstreamJson = { raw: text }; }
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message, upstreamUrl }, 'proxy upstream call failed');
      res.status(502).json({ error: { code: 'PROXY_UPSTREAM_FAILED', message: (err as Error).message } });
      return;
    }
    const upstreamMs = Date.now() - t0;

    // Run detectors over every pending tool call from the response. Tool
    // calls in the REQUEST history already executed in earlier turns —
    // they're audit material, not blockable.
    const pending = adapter.extractPendingToolCalls(upstreamJson);
    const evaluations = await this.evaluatePending(ctx, auth.orgId, pending);

    const blocked = evaluations.filter(e => e.decision === 'block');
    const directive = {
      blockedToolCallIds: blocked.map(b => b.toolCall.id),
      reason: blocked.length === 0
        ? ''
        : blocked.map(b => b.reason).filter(Boolean).slice(0, 3).join(' | '),
    };

    const mangled = directive.blockedToolCallIds.length > 0
      ? adapter.applyBlockingDirective(upstreamJson, directive)
      : upstreamJson;

    // Cost from upstream usage (if reported).
    const usage = adapter.extractUsage(upstreamJson);
    const costUsd = usage
      ? calculateCost(usage.model || ctx.model, usage.promptTokens, usage.completionTokens)
      : 0;

    // Audit row — flows through subscribers → sinks → transparency log
    // automatically (the wiring shipped with the universal sink layer).
    this.deps.audit.log({
      org_id: auth.orgId,
      user_id: undefined,
      user_email: auth.keyName,
      action: 'data.export',           // closest existing AuditAction; v1.1 adds 'proxy.llm_call'
      resource_type: 'trace',
      resource_id: randomUUID(),
      ip_address: req.ip,
      details: {
        proxy: {
          provider: adapter.provider,
          path: tail,
          agent_id: ctx.agentId,
          session_id: ctx.sessionId,
          model: usage?.model || ctx.model,
          upstream_ms: upstreamMs,
          upstream_status: (upstreamRes as globalThis.Response).status,
        },
        cost: {
          input_tokens: usage?.promptTokens ?? 0,
          output_tokens: usage?.completionTokens ?? 0,
          usd: costUsd,
        },
        tool_calls: {
          historic: adapter.extractHistoricToolCalls(req.body).map(redactArgs),
          pending: pending.map(redactArgs),
          blocked: directive.blockedToolCallIds,
        },
        signals: evaluations.flatMap(e => e.signals.map(toAuditSignal)),
      },
    });

    res.status((upstreamRes as globalThis.Response).status);
    // Forward upstream content type where reasonable.
    const upstreamContentType = (upstreamRes as globalThis.Response).headers.get('content-type');
    if (upstreamContentType) res.setHeader('content-type', upstreamContentType);
    res.setHeader('x-aegis-proxy', `${adapter.name}/v1`);
    if (directive.blockedToolCallIds.length > 0) {
      res.setHeader('x-aegis-blocked-tool-calls', String(directive.blockedToolCallIds.length));
    }
    res.send(typeof mangled === 'string' ? mangled : JSON.stringify(mangled));
  };

  private async evaluatePending(
    ctx: { agentId: string; sessionId?: string },
    orgId: string,
    pending: NeutralToolCall[],
  ): Promise<Array<{ toolCall: NeutralToolCall; signals: Signal[]; decision: 'allow' | 'block'; reason?: string }>> {
    const out = [];
    for (const tc of pending) {
      const signals = await this.deps.detectors.evaluateAll({
        tool: { name: tc.name, args: tc.arguments },
        agent: { id: ctx.agentId },
        tenant: { id: orgId },
        session: ctx.sessionId ? { id: ctx.sessionId } : undefined,
      });
      const worst = signals.reduce<Signal | null>(
        (acc, s) => (acc == null || SEVERITY_RANK[s.severity] > SEVERITY_RANK[acc.severity]) ? s : acc,
        null,
      );
      const decision: 'allow' | 'block' = worst && worst.severity === 'critical' ? 'block' : 'allow';
      out.push({
        toolCall: tc,
        signals,
        decision,
        reason: worst?.message,
      });
    }
    return out;
  }

  private checkAuth(req: Request): AuthOk | null {
    const key = lowerCaseHeaders(req.headers)['x-aegis-key'];
    if (!key) return null;

    // Org-scoped API key (preferred).
    if (key.startsWith('aegis_')) {
      const hash = createHash('sha256').update(key).digest('hex');
      const row = this.deps.db.prepare(
        `SELECT org_id, name, key_prefix, revoked_at, expires_at FROM org_api_keys WHERE key_hash = ?`,
      ).get(hash) as { org_id: string; name: string; key_prefix: string; revoked_at: string | null; expires_at: string | null } | undefined;
      if (row && !row.revoked_at) {
        const expired = row.expires_at && new Date(row.expires_at) < new Date();
        if (!expired) return { orgId: row.org_id, keyName: row.name, keyPrefix: row.key_prefix };
      }
      return null;
    }

    // Legacy single-key fallback (community mode).
    const dashRow = this.deps.db.prepare(
      `SELECT value FROM gateway_config WHERE key = 'dashboard_api_key'`,
    ).get() as { value: string } | undefined;
    if (dashRow && dashRow.value === key) {
      return { orgId: 'default', keyName: 'dashboard' };
    }
    return null;
  }
}

function lowerCaseHeaders(h: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return out;
}

function queryStringFrom(req: Request): string {
  const qIdx = req.originalUrl.indexOf('?');
  return qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
}

/** Redact tool-call args before they land in the audit row. We keep the
 *  shape (key names) but blank string values longer than 64 chars and
 *  obviously-secret-looking values. The trace persistence path does the
 *  full PII redaction; here we just keep the audit row from getting
 *  enormous. */
function redactArgs(tc: NeutralToolCall): { id: string; name: string; arg_keys: string[] } {
  return {
    id: tc.id,
    name: tc.name,
    arg_keys: Object.keys(tc.arguments ?? {}),
  };
}

function toAuditSignal(s: Signal): { detector: string; severity: Severity; category: string; message: string } {
  return {
    detector: s.detector,
    severity: s.severity,
    category: s.category,
    message: s.message,
  };
}
