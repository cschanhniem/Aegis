/**
 * AEGIS trace row → OpenTelemetry OTLP JSON-over-HTTP span.
 *
 * Spec: https://github.com/open-telemetry/opentelemetry-proto
 * JSON encoding follows the spec's "ExportTraceServiceRequest" message,
 * which is what every OTLP backend (Datadog, Honeycomb, New Relic,
 * Grafana Tempo, Jaeger, vendor-neutral collectors) accepts at the
 * /v1/traces HTTP endpoint.
 *
 * v1 mapping:
 *   trace_id (UUID)           → 32-hex traceId (hyphens stripped)
 *   trace_id first 16 hex     → spanId
 *   parent_trace_id first 16  → parentSpanId
 *   tool_call.tool_name       → span.name
 *   timestamp                 → startTimeUnixNano
 *   timestamp + duration      → endTimeUnixNano (if observation.duration_ms known)
 *   kind                      → 3 (CLIENT) — tool call is an outbound client request
 *   agent_id / session_id / cost / model / safety_validation → attributes
 *   safety_validation.passed=false → status.code=2 (ERROR)
 */

export interface AegisTraceRow {
  trace_id: string;
  parent_trace_id?: string | null;
  agent_id: string;
  timestamp: string;            // ISO8601
  sequence_number?: number;
  tool_call: string;            // JSON: { tool_name, function, arguments }
  observation?: string;         // JSON: { duration_ms, ... }
  safety_validation?: string | null; // JSON: { passed, risk_level, violations }
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  session_id?: string | null;
  pii_detected?: number | null;
  environment?: string;
}

export interface OtlpKeyValue {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: 0 | 1 | 2 };  // UNSET | OK | ERROR
}

export interface OtlpExportRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

const SCOPE = { name: 'aegis.trace', version: '1.0.0' };

function uuidToHex32(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase().padEnd(32, '0').slice(0, 32);
}

function spanIdFrom(uuid: string): string {
  return uuidToHex32(uuid).slice(0, 16);
}

function isoToUnixNano(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '0';
  return (BigInt(ms) * 1_000_000n).toString();
}

function unixNanoPlusMs(iso: string, ms: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '0';
  return (BigInt(t + Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

function attrStr(key: string, value: string | null | undefined): OtlpKeyValue | null {
  if (value == null || value === '') return null;
  return { key, value: { stringValue: String(value) } };
}

function attrInt(key: string, value: number | null | undefined): OtlpKeyValue | null {
  if (value == null) return null;
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function attrDouble(key: string, value: number | null | undefined): OtlpKeyValue | null {
  if (value == null) return null;
  return { key, value: { doubleValue: value } };
}

function attrBool(key: string, value: boolean): OtlpKeyValue {
  return { key, value: { boolValue: value } };
}

export function convertRowToSpan(row: AegisTraceRow): OtlpSpan {
  let tool: any = {};
  try { tool = JSON.parse(row.tool_call); } catch { /* keep {} */ }
  let obs: any = {};
  try { obs = JSON.parse(row.observation ?? '{}'); } catch { /* keep {} */ }
  let safety: any = null;
  if (row.safety_validation) {
    try { safety = JSON.parse(row.safety_validation); } catch { /* ignore */ }
  }

  const duration = Number(obs?.duration_ms ?? 0);
  const startNs = isoToUnixNano(row.timestamp);
  const endNs = duration > 0 ? unixNanoPlusMs(row.timestamp, duration) : startNs;

  const attrs: OtlpKeyValue[] = [];
  const push = (kv: OtlpKeyValue | null) => { if (kv) attrs.push(kv); };

  push(attrStr('aegis.agent_id', row.agent_id));
  push(attrStr('aegis.session_id', row.session_id ?? undefined));
  push(attrStr('aegis.environment', row.environment));
  push(attrStr('aegis.tool', tool?.tool_name));
  push(attrStr('aegis.tool.function', tool?.function));
  push(attrInt('aegis.sequence', row.sequence_number));
  push(attrStr('llm.model', row.model ?? undefined));
  push(attrInt('llm.tokens.input', row.input_tokens ?? undefined));
  push(attrInt('llm.tokens.output', row.output_tokens ?? undefined));
  push(attrDouble('aegis.cost_usd', row.cost_usd ?? undefined));
  push(attrInt('aegis.duration_ms', duration));
  if (row.pii_detected != null) attrs.push(attrBool('aegis.pii_detected', !!row.pii_detected));
  if (safety) {
    push(attrStr('aegis.policy.risk_level', safety.risk_level));
    push(attrStr('aegis.policy.name', safety.policy_name));
    attrs.push(attrBool('aegis.policy.passed', !!safety.passed));
    if (Array.isArray(safety.violations) && safety.violations.length > 0) {
      push(attrStr('aegis.policy.violations', safety.violations.join(',')));
    }
  }

  const status: { code: 0 | 1 | 2 } =
    safety && safety.passed === false ? { code: 2 } : { code: 1 };

  const span: OtlpSpan = {
    traceId: uuidToHex32(row.trace_id),
    spanId: spanIdFrom(row.trace_id),
    name: String(tool?.tool_name ?? 'tool_call'),
    kind: 3,                              // CLIENT
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    attributes: attrs,
    status,
  };
  if (row.parent_trace_id) {
    span.parentSpanId = spanIdFrom(row.parent_trace_id);
  }
  return span;
}

export function buildExportRequest(
  rows: ReadonlyArray<AegisTraceRow>,
  opts: { serviceName: string; tenantId: string },
): OtlpExportRequest {
  const spans = rows.map(convertRowToSpan);
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: opts.serviceName } },
          { key: 'service.namespace', value: { stringValue: opts.tenantId } },
          { key: 'telemetry.sdk.name', value: { stringValue: 'aegis-otlp' } },
          { key: 'telemetry.sdk.version', value: { stringValue: '1.0.0' } },
        ],
      },
      scopeSpans: [{ scope: SCOPE, spans }],
    }],
  };
}
