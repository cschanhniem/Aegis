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
import { AgentRegistryService } from '../services/agent-registry';
import { AgentIdCardService } from '../services/agent-id-card';
import { CrossAgentCorrelatorService } from '../services/cross-agent-correlator';
import { TaintTrackerService } from '../services/taint-tracker';
import {
  NeutralToolCall,
  ProxyAdapter,
} from './adapter';

const PROXY_PATH_RE = /^\/(openai|anthropic|mistral|gemini)(\/.*)$/;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

export interface ProxyHandlerDeps {
  db: Database.Database;
  logger: Logger;
  detectors: DetectorRegistry;
  audit: AuditLogService;
  adapters: ReadonlyArray<ProxyAdapter>;
  /** Optional — if provided, every proxy call touches the agent registry
   *  and gets blocked when the agent is suspended/deprecated or missing
   *  its required secret. Backward-compatible: missing agentRegistry =
   *  no identity enforcement. */
  agentRegistry?: AgentRegistryService;
  /** Optional — when provided, the proxy accepts X-AEGIS-Agent-Token
   *  (AEGIS Agent ID v1 JWT) as an alternative to the legacy
   *  X-AEGIS-Agent-Secret. Valid JWT → strong attribution. The agent_id
   *  resolved comes from the JWT's sub claim, not the X-AEGIS-Agent-Id
   *  header — so a stolen agent_id can't be paired with a JWT for a
   *  different agent. */
  agentIdCards?: AgentIdCardService;
  /** Optional — when provided, every proxy evaluation observes
   *  signals so the cross-agent detector can spot multi-agent
   *  inheritance on subsequent calls in the same session. */
  crossAgent?: CrossAgentCorrelatorService;
  /** Optional — when provided, sensitive-content touches in this
   *  call's signals get recorded so subsequent outbound calls within
   *  the taint window trigger the T5001 exfil signal. */
  taintTracker?: TaintTrackerService;
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
    let ctx = adapter.extractAegisContext(headers, req.body);

    // ── JWT identity (AEGIS Agent ID v1) ─────────────────────────────
    // If the caller presented an X-AEGIS-Agent-Token, verify it and
    // resolve the agent identity from the JWT's `sub` claim — not the
    // header-claimed X-AEGIS-Agent-Id. This means a stolen agent_id
    // header can't be paired with a JWT for a different agent.
    let jwtValid = false;
    let agentTokenInfo: { kid?: string; exp?: number } | undefined;
    const presentedJwt = headers['x-aegis-agent-token'];
    if (presentedJwt && this.deps.agentIdCards) {
      const v = this.deps.agentIdCards.verify(presentedJwt);
      if (v.ok && v.claims) {
        jwtValid = true;
        // JWT sub WINS over the header agent id — fewer ways to spoof.
        ctx = { ...ctx, agentId: v.claims.sub, sessionId: ctx.sessionId };
        agentTokenInfo = { exp: v.claims.exp };
      } else {
        // Caller sent a token but it's bad — fail fast rather than fall
        // through to header-claimed identity.
        res.status(403).json({
          error: { code: 'AGENT_TOKEN_INVALID', message: v.reason ?? 'JWT verification failed' },
        });
        return;
      }
    }

    // Agent identity gate. Auto-records unknown agent_ids as 'unregistered'
    // (backward compat); blocks if the agent is suspended/deprecated or
    // requires a secret the caller didn't present. attributionStrength is
    // attached to the audit row so compliance reports can distinguish
    // first-party from drive-by traffic.
    let attributionStrength: 'strong' | 'weak' = 'weak';
    if (this.deps.agentRegistry) {
      const presentedSecret = headers['x-aegis-agent-secret'];
      const authz = this.deps.agentRegistry.authorize({
        orgId: auth.orgId,
        agentId: ctx.agentId,
        presentedSecret,
        presentedJwtValid: jwtValid,
      });
      if (authz?.blocked) {
        res.status(403).json({
          error: {
            code: 'AGENT_IDENTITY_BLOCKED',
            message: authz.blockReason,
            agent_status: authz.agent.status,
          },
        });
        return;
      }
      if (authz) attributionStrength = authz.attributionStrength;
    }

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
    // they're audit material, not blockable. Earlier-turn tool RESULTS
    // ARE flowed in as untrusted conversation surface so the IPI
    // detector can scan them for embedded instructions.
    const pending = adapter.extractPendingToolCalls(upstreamJson);
    const toolResultContent = adapter.extractToolResultContent(req.body);
    const evaluations = await this.evaluatePending(
      { agentId: ctx.agentId, sessionId: ctx.sessionId, toolResultContent },
      auth.orgId,
      pending,
    );

    const allSignals = evaluations.flatMap(e => e.signals);

    // Feed the cross-agent correlator so the NEXT call in this session
    // can spot inheritance. Pass the flattened signal list (the correlator
    // only cares about severity for now).
    if (this.deps.crossAgent) {
      this.deps.crossAgent.observe({
        orgId: auth.orgId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        signals: allSignals,
      });
    }
    // Feed the taint tracker so NEXT outbound call in this session can
    // see the temporal connection to sensitive-content access.
    if (this.deps.taintTracker) {
      this.deps.taintTracker.observe({
        orgId: auth.orgId,
        sessionId: ctx.sessionId,
        signals: allSignals,
      });
    }

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
      action: 'proxy.llm_call',
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
          attribution_strength: attributionStrength,
          identity_proof: agentTokenInfo
            ? { type: 'jwt', token_exp: agentTokenInfo.exp }
            : (headers['x-aegis-agent-secret'] ? { type: 'secret' } : { type: 'header-only' }),
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
    ctx: { agentId: string; sessionId?: string; toolResultContent?: string[] },
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
        conversation: ctx.toolResultContent && ctx.toolResultContent.length > 0
          ? { toolResultContent: ctx.toolResultContent }
          : undefined,
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
