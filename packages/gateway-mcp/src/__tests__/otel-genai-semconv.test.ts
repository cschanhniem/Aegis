/**
 * GenAI OpenTelemetry semantic-convention tests.
 *
 * Pins the `gen_ai.*` attribute set every major APM dashboard expects:
 *
 *   - gen_ai.system                 — provider id ('anthropic', 'openai', etc.)
 *   - gen_ai.request.model          — model identifier
 *   - gen_ai.response.model         — same (we don't model-rewrite)
 *   - gen_ai.operation.name         — chat / text_completion / embedding / tool_call
 *   - gen_ai.usage.input_tokens     — prompt tokens
 *   - gen_ai.usage.output_tokens    — completion tokens
 *   - gen_ai.usage.total_tokens     — sum
 *   - gen_ai.conversation.id        — session correlation
 *   - gen_ai.response.finish_reasons — array
 *
 *   + guardrail extension (proposed semconv, used by Traceloop / OpenLLMetry):
 *   - gen_ai.guardrail.{name,action,category,severity,reason}
 *
 * The test wires an in-memory exporter and asserts each attribute lands
 * on the emitted span. We DON'T test the full express stack here — that's
 * covered by otel-tracing.test.ts. This file is specifically the semconv
 * contract.
 */
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace, context } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { emitTraceSpan, emitGuardrailSpan } from '../services/otel';

// Wire a fresh provider + in-memory exporter for these tests. We force
// OTEL_EXPORTER_OTLP_ENDPOINT='in-memory' so the legacy gate in
// emitTraceSpan / emitGuardrailSpan resolves true.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'in-memory';

const ctxManager = new AsyncHooksContextManager();
ctxManager.enable();
context.setGlobalContextManager(ctxManager);

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);

beforeEach(() => exporter.reset());

describe('emitTraceSpan — GenAI semconv attributes', () => {
  test('chat span carries every required gen_ai.* attribute', () => {
    emitTraceSpan({
      traceId: 't-1', agentId: 'a-1', toolName: 'anthropic.messages.create',
      riskLevel: 'LOW', blocked: false, costUsd: 0.0123, piiDetected: 0, durationMs: 250,
      model: 'claude-opus-4-7', provider: 'anthropic',
      inputTokens: 320, outputTokens: 64,
      operationName: 'chat',
      conversationId: 'sess-abc', finishReason: 'end_turn',
    });
    const span = exporter.getFinishedSpans().find(s => s.name === 'chat claude-opus-4-7');
    expect(span).toBeDefined();
    expect(span?.attributes['gen_ai.system']).toBe('anthropic');
    expect(span?.attributes['gen_ai.request.model']).toBe('claude-opus-4-7');
    expect(span?.attributes['gen_ai.response.model']).toBe('claude-opus-4-7');
    expect(span?.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span?.attributes['gen_ai.usage.input_tokens']).toBe(320);
    expect(span?.attributes['gen_ai.usage.output_tokens']).toBe(64);
    expect(span?.attributes['gen_ai.usage.total_tokens']).toBe(384);
    expect(span?.attributes['gen_ai.conversation.id']).toBe('sess-abc');
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    // AEGIS extension attributes coexist on the same span.
    expect(span?.attributes['aegis.cost_usd']).toBe(0.0123);
    expect(span?.attributes['aegis.agent_id']).toBe('a-1');
  });

  test('span name uses GenAI semconv format "<operation> <model>" when both present', () => {
    emitTraceSpan({
      traceId: 't', agentId: 'a', toolName: 'openai.embeddings.create',
      riskLevel: 'LOW', blocked: false, costUsd: 0, piiDetected: 0, durationMs: 10,
      model: 'text-embedding-3-small', provider: 'openai',
      operationName: 'embedding', inputTokens: 100, outputTokens: 0,
    });
    expect(exporter.getFinishedSpans().some(s => s.name === 'embedding text-embedding-3-small')).toBe(true);
  });

  test('span name falls back to "tool_call/<tool>" when no model', () => {
    emitTraceSpan({
      traceId: 't', agentId: 'a', toolName: 'web_search',
      riskLevel: 'LOW', blocked: false, costUsd: 0, piiDetected: 0, durationMs: 5,
    });
    expect(exporter.getFinishedSpans().some(s => s.name === 'tool_call/web_search')).toBe(true);
  });

  test('totals are correctly summed even when one side is zero', () => {
    emitTraceSpan({
      traceId: 't', agentId: 'a', toolName: 'x',
      riskLevel: 'LOW', blocked: false, costUsd: 0, piiDetected: 0, durationMs: 1,
      model: 'gpt-4o', provider: 'openai', inputTokens: 0, outputTokens: 0,
    });
    const span = exporter.getFinishedSpans().pop()!;
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(0);
  });
});

describe('emitGuardrailSpan — proposed gen_ai.guardrail.* extension', () => {
  test('block decision emits guardrail span with ERROR status', () => {
    emitGuardrailSpan({
      decision: 'block', policy: 'sql-injection', category: 'database',
      riskLevel: 'HIGH', reason: 'DROP TABLE detected',
      orgId: 'acme', agentId: 'a-9',
    });
    const span = exporter.getFinishedSpans().find(s => s.name === 'guardrail.block');
    expect(span).toBeDefined();
    expect(span?.attributes['gen_ai.guardrail.name']).toBe('sql-injection');
    expect(span?.attributes['gen_ai.guardrail.action']).toBe('block');
    expect(span?.attributes['gen_ai.guardrail.category']).toBe('database');
    expect(span?.attributes['gen_ai.guardrail.severity']).toBe('HIGH');
    expect(span?.attributes['gen_ai.guardrail.reason']).toBe('DROP TABLE detected');
    expect(span?.status.code).toBe(2);   // ERROR
  });

  test('allow decision emits guardrail span with OK status', () => {
    emitGuardrailSpan({ decision: 'allow', policy: 'none', orgId: 'acme', agentId: 'a-1' });
    const span = exporter.getFinishedSpans().find(s => s.name === 'guardrail.allow');
    expect(span).toBeDefined();
    expect(span?.attributes['gen_ai.guardrail.action']).toBe('allow');
    // No explicit ERROR status for allow.
    expect(span?.status.code).not.toBe(2);
  });

  test('pending decision is encoded distinctly', () => {
    emitGuardrailSpan({ decision: 'pending', orgId: 'acme', agentId: 'a-1' });
    expect(exporter.getFinishedSpans().some(s => s.name === 'guardrail.pending')).toBe(true);
  });
});
