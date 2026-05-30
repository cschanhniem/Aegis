/**
 * Adapter for Anthropic `/v1/messages` (Claude direct + Vertex/Bedrock
 * proxies that mirror the Messages API shape).
 *
 * Wire shape:
 *
 *   request.messages[]:
 *     { role: 'user'|'assistant', content: string | ContentBlock[] }
 *     ContentBlock: { type: 'text'|'tool_use'|'tool_result', ... }
 *       - tool_use   = { type:'tool_use', id, name, input: object }
 *       - tool_result = { type:'tool_result', tool_use_id, content }
 *
 *   response:
 *     { content: ContentBlock[], stop_reason, usage: {input_tokens, output_tokens, ...}, model }
 *
 * Blocking shape:
 *   For each tool_use we want to block in the response, replace its block
 *   with a `{ type: 'text', text: 'AEGIS blocked …' }` block. If all
 *   tool_use blocks are gone, set stop_reason='end_turn'. Customer's host
 *   runtime sees a refusal text instead of a tool request.
 */

import { createHash } from 'crypto';
import {
  BlockingDirective,
  NeutralToolCall,
  NeutralUsage,
  ProxyAdapter,
} from '../adapter';

const UPSTREAM_BASE = 'https://api.anthropic.com';
const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-connection',
  'expect',
]);
const AEGIS_HEADERS = ['x-aegis-key', 'x-aegis-agent-id', 'x-aegis-agent-secret', 'x-aegis-session-id'];

export class AnthropicMessagesAdapter implements ProxyAdapter {
  readonly name = 'anthropic-messages' as const;
  readonly provider = 'anthropic' as const;

  upstreamUrl(pathAfterProvider: string, search: string): string {
    const clean = pathAfterProvider.startsWith('/') ? pathAfterProvider : '/' + pathAfterProvider;
    return `${UPSTREAM_BASE}${clean}${search}`;
  }

  upstreamHeaders(incoming: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (AEGIS_HEADERS.includes(lk)) continue;
      out[lk] = v;
    }
    return out;
  }

  preflightReject(requestBody: any): string | null {
    if (requestBody?.stream === true) {
      return 'AEGIS proxy v1 does not inspect SSE streaming responses; set stream=false or use the SDK auto-instrumentation for streaming workloads.';
    }
    return null;
  }

  extractHistoricToolCalls(requestBody: any): NeutralToolCall[] {
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    const out: NeutralToolCall[] = [];
    for (const m of messages) {
      const content = m?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && block?.name) {
          out.push({
            id: String(block.id ?? ''),
            name: String(block.name),
            arguments: (block.input && typeof block.input === 'object') ? block.input : {},
            location: 'request',
          });
        }
      }
    }
    return out;
  }

  extractPendingToolCalls(responseBody: any): NeutralToolCall[] {
    const content = responseBody?.content;
    if (!Array.isArray(content)) return [];
    const out: NeutralToolCall[] = [];
    for (const block of content) {
      if (block?.type === 'tool_use' && block?.name) {
        out.push({
          id: String(block.id ?? ''),
          name: String(block.name),
          arguments: (block.input && typeof block.input === 'object') ? block.input : {},
          location: 'response',
        });
      }
    }
    return out;
  }

  extractUsage(responseBody: any): NeutralUsage | null {
    const u = responseBody?.usage;
    if (!u) return null;
    const prompt = Number(u.input_tokens ?? 0);
    const completion = Number(u.output_tokens ?? 0);
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      model: String(responseBody?.model ?? ''),
    };
  }

  applyBlockingDirective(responseBody: any, directive: BlockingDirective): any {
    if (directive.blockedToolCallIds.length === 0) return responseBody;
    const blocked = new Set(directive.blockedToolCallIds);
    const content = responseBody?.content;
    if (!Array.isArray(content)) return responseBody;

    const droppedNames: string[] = [];
    const next = content.map((block: any) => {
      if (block?.type === 'tool_use' && blocked.has(String(block.id))) {
        droppedNames.push(String(block.name));
        return {
          type: 'text',
          text: `AEGIS blocked tool '${block.name}'. Reason: ${directive.reason}`,
        };
      }
      return block;
    });
    responseBody.content = next;
    if (droppedNames.length > 0 && !next.some((b: any) => b?.type === 'tool_use')) {
      responseBody.stop_reason = 'end_turn';
    }
    return responseBody;
  }

  extractAegisContext(headers: Record<string, string>, requestBody: any) {
    const agentId =
      headers['x-aegis-agent-id'] ??
      synthAgentId(headers['x-api-key'] ?? headers['authorization'] ?? '');
    const sessionId = headers['x-aegis-session-id'];
    return {
      agentId,
      sessionId,
      model: String(requestBody?.model ?? ''),
    };
  }
}

function synthAgentId(authMaterial: string): string {
  const h = createHash('sha256').update(authMaterial).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
