/**
 * Mistral chat-completions adapter.
 *
 * Mistral's public API at api.mistral.ai/v1/chat/completions is
 * OpenAI-compatible at the request/response shape (messages[] in,
 * choices[].message.tool_calls out), so we delegate every parse / shape
 * operation to a private OpenAIChatAdapter instance and only override
 * the upstream URL + name/provider tags. Composition (not inheritance)
 * because TypeScript narrows the parent's name/provider literal types,
 * which collide if we try to subclass.
 */

import {
  BlockingDirective,
  NeutralToolCall,
  NeutralUsage,
  ProxyAdapter,
} from '../adapter';
import { OpenAIChatAdapter } from './openai-chat';

const UPSTREAM_BASE = 'https://api.mistral.ai';

export class MistralChatAdapter implements ProxyAdapter {
  readonly name = 'mistral-chat' as const;
  readonly provider = 'mistral' as const;
  private readonly openai = new OpenAIChatAdapter();

  upstreamUrl(pathAfterProvider: string, search: string): string {
    const clean = pathAfterProvider.startsWith('/') ? pathAfterProvider : '/' + pathAfterProvider;
    return `${UPSTREAM_BASE}${clean}${search}`;
  }
  upstreamHeaders(incoming: Record<string, string>): Record<string, string> {
    return this.openai.upstreamHeaders(incoming);
  }
  preflightReject(body: any): string | null { return this.openai.preflightReject(body); }
  extractHistoricToolCalls(body: any): NeutralToolCall[] { return this.openai.extractHistoricToolCalls(body); }
  extractToolResultContent(body: any): string[] { return this.openai.extractToolResultContent(body); }
  extractPendingToolCalls(body: any): NeutralToolCall[] { return this.openai.extractPendingToolCalls(body); }
  extractUsage(body: any): NeutralUsage | null { return this.openai.extractUsage(body); }
  applyBlockingDirective(body: any, directive: BlockingDirective): any {
    return this.openai.applyBlockingDirective(body, directive);
  }
  extractAegisContext(headers: Record<string, string>, body: any) {
    return this.openai.extractAegisContext(headers, body);
  }
}
