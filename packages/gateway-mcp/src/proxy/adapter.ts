/**
 * LLM egress proxy adapter contract.
 *
 * One adapter per upstream API surface (openai chat, anthropic messages,
 * future: openai responses, bedrock invoke, gemini generate-content). The
 * adapter knows the wire format; the proxy handler is provider-agnostic.
 *
 * Responsibilities split:
 *
 *   adapter     parses request/response into provider-neutral records;
 *               re-serializes a mangled response when the decision layer
 *               wants to block a tool call.
 *
 *   handler     runs the Detector registry + DSL + audit + transparency
 *               on the provider-neutral records, then asks the adapter to
 *               re-shape the response if needed.
 *
 * v1 supports non-streaming requests only. Streaming (stream=true) is
 * explicitly rejected at the handler so customers don't silently bypass
 * pre-execution checks. SSE inspection lands in v1.1.
 */

/**
 * One tool invocation the model wants the host runtime to execute. Both
 * request-side (what the model asked for in earlier turns, present in
 * `messages`) and response-side (what the model is asking for now) are
 * normalized into this record.
 */
export interface NeutralToolCall {
  /** Provider-assigned id (OpenAI: tool_calls[].id, Anthropic: tool_use[].id). */
  id: string;
  /** Tool / function name. */
  name: string;
  /** Parsed JSON arguments. Empty object if the upstream sent a non-JSON arg blob. */
  arguments: Record<string, unknown>;
  /** Where in the wire payload this came from — used by re-shapers. */
  location: 'request' | 'response';
}

/** Token usage extracted from the response (or estimated from the request
 *  if the upstream didn't emit usage stats). */
export interface NeutralUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported model id, used to look up per-1k pricing. */
  model: string;
}

/** What the decision layer hands back to the adapter for response shaping. */
export interface BlockingDirective {
  /** Tool calls (by id) the model wanted that must NOT execute. The adapter
   *  replaces them with a refusal message so the host runtime sees a clean
   *  "tool not available" response and the model can recover gracefully. */
  blockedToolCallIds: ReadonlyArray<string>;
  /** Human-readable explanation the adapter inlines into the refusal. */
  reason: string;
}

export interface ProxyAdapter {
  readonly name: 'openai-chat' | 'anthropic-messages';
  readonly provider: 'openai' | 'anthropic';

  /** Compute the upstream URL from the incoming proxy path + the upstream
   *  base. The proxy mounts at /api/v1/proxy/<provider>/<rest>, so
   *  upstreamUrl strips the prefix and joins onto the upstream base. */
  upstreamUrl(pathAfterProvider: string, search: string): string;

  /** Headers to forward to the upstream. Must NOT include AEGIS-internal
   *  headers (X-AEGIS-*) and must strip Host. The customer's upstream auth
   *  header (e.g. Authorization, x-api-key) IS forwarded — BYO key model. */
  upstreamHeaders(incoming: Record<string, string>): Record<string, string>;

  /** Hard reject if the request would bypass v1's security guarantees
   *  (e.g. streaming, which v1 can't inspect). Returns a 400 message or
   *  null if the request is acceptable. */
  preflightReject(requestBody: any): string | null;

  /** Tool calls already in the conversation history (from earlier turns).
   *  Used for context but not blockable — those tool calls already executed
   *  before the request reached AEGIS. */
  extractHistoricToolCalls(requestBody: any): NeutralToolCall[];

  /** Text content from earlier-turn tool results — web fetches, RAG hits,
   *  file reads, email bodies, anything the LLM read from a tool and
   *  whose author is NOT the user. The IPI detector treats every
   *  returned string as untrusted and scans for embedded instructions. */
  extractToolResultContent(requestBody: any): string[];

  /** Tool calls the model wants the host runtime to execute NOW. These are
   *  the blockable ones — they haven't run yet. */
  extractPendingToolCalls(responseBody: any): NeutralToolCall[];

  /** Token usage from the upstream response. */
  extractUsage(responseBody: any): NeutralUsage | null;

  /** Re-shape the upstream response so blocked tool calls become refusal
   *  messages the model treats as "tool not available". Returns the mutated
   *  body (caller serializes to JSON). */
  applyBlockingDirective(responseBody: any, directive: BlockingDirective): any;

  /** Pull AEGIS metadata the proxy needs from the incoming headers / body.
   *  The proxy convention: client sends X-AEGIS-Agent-Id; if absent the
   *  proxy synthesizes one from a deterministic hash of the auth header. */
  extractAegisContext(headers: Record<string, string>, requestBody: any): {
    agentId: string;
    sessionId?: string;
    model: string;
  };
}
