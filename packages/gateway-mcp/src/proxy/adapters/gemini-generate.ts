/**
 * Google Gemini `:generateContent` adapter.
 *
 * Wire shape (v1beta / v1):
 *
 *   POST /v1beta/models/{model}:generateContent
 *
 *   request: {
 *     contents: [{ role: 'user'|'model', parts: [{ text: string }
 *                                                | { functionResponse: { name, response } }
 *                                                | { functionCall: { name, args } }] }],
 *     tools?:  [{ functionDeclarations: [{ name, description, parameters }] }],
 *     systemInstruction?, generationConfig?, safetySettings?,
 *   }
 *
 *   response: {
 *     candidates: [{ content: { role: 'model', parts: [{ text } | { functionCall: { name, args } }] },
 *                    finishReason, safetyRatings, ... }],
 *     usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount },
 *     modelVersion, ...
 *   }
 *
 * Auth (Google's two supported modes):
 *   - API key:  ?key=<value> on the URL — pass-through the customer's query string verbatim
 *   - OAuth:    Authorization: Bearer ya29.... header — pass-through verbatim
 * Either way, AEGIS doesn't touch the auth; AEGIS-internal headers are
 * stripped before forwarding.
 *
 * Blocking shape:
 *   For each candidate's content.parts, drop the `functionCall` block and
 *   replace with a text block "AEGIS blocked tool '<name>'. Reason: ...".
 *   If ALL candidates' functionCalls were dropped, set finishReason='STOP'.
 */

import { createHash } from 'crypto';
import {
  BlockingDirective,
  NeutralToolCall,
  NeutralUsage,
  ProxyAdapter,
} from '../adapter';

const UPSTREAM_BASE = 'https://generativelanguage.googleapis.com';
const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-connection', 'expect',
]);
const AEGIS_HEADERS = ['x-aegis-key', 'x-aegis-agent-id', 'x-aegis-agent-secret', 'x-aegis-agent-token', 'x-aegis-session-id', 'x-aegis-build-artifact', 'x-aegis-source-commit'];

export class GeminiGenerateAdapter implements ProxyAdapter {
  readonly name = 'gemini-generate' as const;
  readonly provider = 'gemini' as const;

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
    // Gemini streaming uses :streamGenerateContent (different path), not a
    // body flag. If the customer is on the streaming path we let it
    // through; this adapter is only mounted for :generateContent. We
    // still reject explicit stream=true on the body for safety.
    if (requestBody?.stream === true) {
      return 'AEGIS proxy v1 does not inspect SSE streaming; use the non-streaming :generateContent path or the SDK.';
    }
    return null;
  }

  extractHistoricToolCalls(requestBody: any): NeutralToolCall[] {
    const contents = Array.isArray(requestBody?.contents) ? requestBody.contents : [];
    const out: NeutralToolCall[] = [];
    for (const turn of contents) {
      const parts = Array.isArray(turn?.parts) ? turn.parts : [];
      for (const p of parts) {
        if (p?.functionCall?.name) {
          out.push({
            id: deriveId(turn?.role ?? 'model', p.functionCall.name),
            name: String(p.functionCall.name),
            arguments: (p.functionCall.args && typeof p.functionCall.args === 'object') ? p.functionCall.args : {},
            location: 'request',
          });
        }
      }
    }
    return out;
  }

  extractToolResultContent(requestBody: any): string[] {
    const contents = Array.isArray(requestBody?.contents) ? requestBody.contents : [];
    const out: string[] = [];
    for (const turn of contents) {
      const parts = Array.isArray(turn?.parts) ? turn.parts : [];
      for (const p of parts) {
        if (p?.functionResponse?.response) {
          const r = p.functionResponse.response;
          out.push(typeof r === 'string' ? r : JSON.stringify(r));
        }
      }
    }
    return out;
  }

  extractPendingToolCalls(responseBody: any): NeutralToolCall[] {
    const candidates = Array.isArray(responseBody?.candidates) ? responseBody.candidates : [];
    const out: NeutralToolCall[] = [];
    for (let ci = 0; ci < candidates.length; ci++) {
      const parts = Array.isArray(candidates[ci]?.content?.parts) ? candidates[ci].content.parts : [];
      for (let pi = 0; pi < parts.length; pi++) {
        const p = parts[pi];
        if (p?.functionCall?.name) {
          out.push({
            id: `cand-${ci}-part-${pi}-${p.functionCall.name}`,
            name: String(p.functionCall.name),
            arguments: (p.functionCall.args && typeof p.functionCall.args === 'object') ? p.functionCall.args : {},
            location: 'response',
          });
        }
      }
    }
    return out;
  }

  extractUsage(responseBody: any): NeutralUsage | null {
    const u = responseBody?.usageMetadata;
    if (!u) return null;
    return {
      promptTokens:     Number(u.promptTokenCount ?? 0),
      completionTokens: Number(u.candidatesTokenCount ?? 0),
      totalTokens:      Number(u.totalTokenCount ?? 0),
      model:            String(responseBody?.modelVersion ?? ''),
    };
  }

  applyBlockingDirective(responseBody: any, directive: BlockingDirective): any {
    if (directive.blockedToolCallIds.length === 0) return responseBody;
    const blocked = new Set(directive.blockedToolCallIds);
    const candidates = Array.isArray(responseBody?.candidates) ? responseBody.candidates : [];
    let anyBlockedHere = false;
    let allFunctionCallsDropped = true;

    candidates.forEach((cand: any, ci: number) => {
      const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
      const next: any[] = [];
      const droppedNames: string[] = [];
      let stillHasFnCall = false;
      parts.forEach((p: any, pi: number) => {
        if (p?.functionCall?.name) {
          const id = `cand-${ci}-part-${pi}-${p.functionCall.name}`;
          if (blocked.has(id)) {
            droppedNames.push(String(p.functionCall.name));
            anyBlockedHere = true;
            return;   // drop this part
          }
          stillHasFnCall = true;
        }
        next.push(p);
      });
      if (droppedNames.length > 0) {
        next.push({
          text: `AEGIS blocked tool ${droppedNames.length === 1 ? `'${droppedNames[0]}'` : droppedNames.join(', ')}. Reason: ${directive.reason}`,
        });
      }
      if (stillHasFnCall) allFunctionCallsDropped = false;
      if (cand?.content) cand.content.parts = next;
    });

    if (anyBlockedHere && allFunctionCallsDropped) {
      for (const cand of candidates) {
        if (cand.finishReason === 'TOOL_CALL' || cand.finishReason === 'tool_call' || cand.finishReason === undefined) {
          cand.finishReason = 'STOP';
        }
      }
    }
    return responseBody;
  }

  extractAegisContext(headers: Record<string, string>, requestBody: any): {
    agentId: string; sessionId?: string; model: string;
  } {
    const agentId =
      headers['x-aegis-agent-id'] ??
      synthAgentId(headers['authorization'] ?? headers['x-goog-api-key'] ?? '');
    const sessionId = headers['x-aegis-session-id'];
    return {
      agentId,
      sessionId,
      // Gemini puts the model in the URL path, not the body; we leave
      // this empty and rely on the response's modelVersion.
      model: '',
    };
  }
}

function deriveId(role: string, name: string): string {
  const h = createHash('sha256').update(`${role}|${name}`).digest('hex');
  return `hist-${h.slice(0, 12)}-${name}`;
}

function synthAgentId(authMaterial: string): string {
  const h = createHash('sha256').update(authMaterial).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
