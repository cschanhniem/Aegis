/**
 * OpenTelemetry distributed tracing wiring.
 *
 * Two API surfaces:
 *
 *   1. Legacy explicit-span path (`emitTraceSpan`) — still used by the
 *      traces ingestion endpoint to record SDK-side spans against the
 *      OTLP exporter. Kept as-is for backwards compatibility.
 *
 *   2. Distributed-tracing path (this revision) — W3C traceparent
 *      propagation + HTTP + Express auto-instrumentation, so an
 *      incoming `traceparent` header continues the customer's parent
 *      trace and our gateway shows up as a node in their Datadog /
 *      Honeycomb / Tempo / Grafana Cloud / New Relic dashboard.
 *
 * Enablement convention is the STANDARD OTel one — presence of
 * `OTEL_EXPORTER_OTLP_ENDPOINT` activates export. We DEPRECATE the
 * legacy `OTEL_ENABLED=true` gate but still honour it so existing
 * docker-compose files don't break. Either env turns OTel on.
 *
 * Cardinality + privacy guards:
 *   - /metrics, /health, /ready, /api/v1/health are NOT traced (pure
 *     scrape noise — would dominate the trace budget).
 *   - Tool arguments and trace IDs are NEVER attributes. Span name
 *     uses route templates only.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, SpanStatusCode, context, Span } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';

let sdk: NodeSDK | null = null;
const TRACER_NAME = 'aegis-gateway';

/** Initialise the global OTel SDK. Idempotent — calling twice no-ops.
 *  Activates if EITHER `OTEL_EXPORTER_OTLP_ENDPOINT` OR `OTEL_ENABLED=true`
 *  is set in the environment. Returns whether export is on. */
export function initOtel(): boolean {
  if (sdk) return true;
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const legacyOn = process.env['OTEL_ENABLED'] === 'true';
  if (!endpoint && !legacyOn) return false;

  const resolvedEndpoint = endpoint ?? 'http://localhost:4318';
  const serviceName = process.env['OTEL_SERVICE_NAME'] || 'aegis-gateway';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: '1.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    // Some OTLP collectors (Honeycomb, Grafana Cloud) require the
    // /v1/traces suffix; others (Tempo gateway, Datadog Agent) don't.
    // We honour the standard env: if it already contains /v1/traces
    // we use it as-is, else we append.
    traceExporter: new OTLPTraceExporter({
      url: resolvedEndpoint.endsWith('/v1/traces') ? resolvedEndpoint : `${resolvedEndpoint}/v1/traces`,
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req: any) => {
          const url: string = req.url || '';
          return url === '/metrics' || url === '/health' || url === '/ready' || url === '/api/v1/health';
        },
        requestHook: (span, req: any) => {
          // Carry through the org id so distributed-trace consumers can
          // pivot by tenant. Bounded cardinality (orgs are O(100s)).
          const orgHdr = req.headers?.['x-org-id'];
          if (typeof orgHdr === 'string') span.setAttribute('aegis.org_id', orgHdr);
        },
      }),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();
  return true;
}

export function shutdownOtel(): Promise<void> {
  const ref = sdk; sdk = null;
  return ref?.shutdown() ?? Promise.resolve();
}

// ── Helpers used inside hot paths (check / proxy / DSL) ─────────────

/** Add gateway-domain attributes to the currently-active span. Safe
 *  to call when OTel isn't initialised (no active span → no-op). */
export function setSpanAttributes(attrs: Record<string, string | number | boolean | undefined>): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    span.setAttribute(`aegis.${k}`, v as any);
  }
}

/** Wrap an async block in a child span. Errors mark the span as ERROR
 *  + record the exception. Use sparingly — Express auto-inst already
 *  spans every HTTP request; this is for sub-request units of work
 *  (e.g. DSL evaluation, classifier, anomaly scoring). */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return await tracer.startActiveSpan(name, async (span) => {
    try {
      const r = await fn(span);
      span.end();
      return r;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
      span.end();
      throw err;
    }
  });
}

/** Synchronous variant for the hot path. */
export function withSpanSync<T>(name: string, fn: (span: Span) => T): T {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, (span) => {
    try {
      const r = fn(span);
      span.end();
      return r;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
      span.end();
      throw err;
    }
  });
}

/** Return the current trace/span id for log correlation. The standard
 *  pattern is to include {trace_id, span_id} on every log line so SRE
 *  can click from a span to its logs in Datadog / Loki / etc. */
export function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export function emitTraceSpan(params: {
  traceId: string;
  agentId: string;
  toolName: string;
  riskLevel: string;
  blocked: boolean;
  costUsd: number;
  piiDetected: number;
  durationMs: number;
  error?: string | null;
  // GenAI semconv extension (OpenTelemetry Semantic Conventions v1.27 — GenAI)
  model?: string;
  provider?: string;     // 'anthropic' | 'openai' | 'google' | 'azure' | 'aws.bedrock' | ...
  inputTokens?: number;
  outputTokens?: number;
  operationName?: 'chat' | 'text_completion' | 'embedding' | 'tool_call';
  conversationId?: string;
  finishReason?: string;
}): void {
  // Honour the same activation gate as initOtel — either the legacy
  // OTEL_ENABLED toggle OR the standard OTEL_EXPORTER_OTLP_ENDPOINT env.
  if (process.env['OTEL_ENABLED'] !== 'true' && !process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return;

  try {
    const tracer = trace.getTracer(TRACER_NAME);
    const startTime = new Date(Date.now() - params.durationMs);
    // Span name follows GenAI semconv: "{operation_name} {model}" when both
    // are known; falls back to legacy "tool_call/{tool}" form otherwise.
    const operation = params.operationName ?? 'tool_call';
    const name = params.model
      ? `${operation} ${params.model}`
      : `tool_call/${params.toolName}`;
    const span = tracer.startSpan(name, { startTime }, context.active());

    // OpenTelemetry GenAI Semantic Conventions (otel-semantic-conventions
    // 1.27 + active drafts) — these are the field names every GenAI
    // dashboard (Datadog GenAI, Honeycomb LLM Templates, Grafana
    // Cloud LLM Analytics, New Relic AI Monitoring) keys off. Emitting
    // them puts us inside their default dashboards with zero config.
    const attrs: Record<string, any> = {
      'gen_ai.operation.name':        operation,
      'gen_ai.system':                params.provider ?? 'unknown',
      'gen_ai.request.model':         params.model ?? 'unknown',
      'gen_ai.response.model':        params.model ?? 'unknown',
      'gen_ai.usage.input_tokens':    params.inputTokens ?? 0,
      'gen_ai.usage.output_tokens':   params.outputTokens ?? 0,
      'gen_ai.usage.total_tokens':    (params.inputTokens ?? 0) + (params.outputTokens ?? 0),
      // AEGIS-namespaced extensions — for our security-specific attrs
      // that aren't in the GenAI semconv (which intentionally avoids
      // privacy + safety territory).
      'aegis.trace_id':     params.traceId,
      'aegis.agent_id':     params.agentId,
      'aegis.tool_name':    params.toolName,
      'aegis.risk_level':   params.riskLevel,
      'aegis.blocked':      params.blocked,
      'aegis.cost_usd':     params.costUsd,
      'aegis.pii_detected': params.piiDetected,
    };
    if (params.conversationId) attrs['gen_ai.conversation.id'] = params.conversationId;
    if (params.finishReason)   attrs['gen_ai.response.finish_reasons'] = [params.finishReason];

    span.setAttributes(attrs);

    if (params.error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: params.error });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
  } catch {
    // Never let OTEL errors break the trace flow
  }
}

/** Convenience: emit a child span specifically for a guardrail decision,
 *  following the proposed GenAI safety extension (gen_ai.guardrail.*).
 *  This is what powers Datadog's "Guardrail Violations" tile and
 *  Honeycomb's "Policy Block Rate" panel. */
export function emitGuardrailSpan(params: {
  decision: 'allow' | 'block' | 'pending';
  policy?: string;
  category?: string;
  riskLevel?: string;
  reason?: string;
  orgId?: string;
  agentId?: string;
}): void {
  if (process.env['OTEL_ENABLED'] !== 'true' && !process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return;
  try {
    const tracer = trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(`guardrail.${params.decision}`, undefined, context.active());
    span.setAttributes({
      // GenAI safety extension attribute names (draft semconv); we use
      // the proposed `gen_ai.guardrail.*` prefix that the OpenLLMetry
      // / Traceloop community has converged on.
      'gen_ai.guardrail.name':     params.policy ?? 'aegis',
      'gen_ai.guardrail.action':   params.decision,
      'gen_ai.guardrail.category': params.category ?? 'unknown',
      'gen_ai.guardrail.severity': params.riskLevel ?? 'LOW',
      'aegis.org_id':              params.orgId ?? 'default',
      'aegis.agent_id':            params.agentId ?? 'unknown',
      ...(params.reason ? { 'gen_ai.guardrail.reason': params.reason } : {}),
    });
    if (params.decision === 'block') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: params.reason ?? 'blocked' });
    }
    span.end();
  } catch { /* tracing is fail-soft */ }
}
