/**
 * Data-exfiltration detector — flags outbound-shaped tool calls carrying
 * large or high-entropy payloads.
 *
 * Coverage:
 *   AAT-T5003  Upload to External Destination — upload-like tool with
 *              non-allowlisted target.
 *   AAT-T5004  Large-Payload Outbound          — single payload above the
 *              configured byte ceiling (default 50KB).
 *   AAT-T5005  Encoded / Obfuscated Exfil      — high-entropy base64 / hex
 *              blob above the configured ceiling (default 4KB).
 *
 * Heuristic, not a leak-prevention DLP — that's the customer's existing
 * stack's job (Symantec / Forcepoint / Netskope) which the universal
 * sink layer already pipes into. This detector is the agent-side
 * pre-execution gate that catches obvious cases inline.
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';

const NAME = 'aegis.builtin.exfil';
const VERSION = '1.0.0';

// Tool name patterns that smell like outbound transport.
const OUTBOUND_TOOL_PATTERNS = [
  /^(http|fetch|request|get|post|put|curl|wget)/i,
  /^(send|post|push|upload|publish|notify)/i,
  /^webhook/i,
  /^email/i,
  /^slack/i,
  /^s3_?(put|upload)/i,
  /^gcs_?(put|upload)/i,
  /^azure_?(blob|upload)/i,
];

const BASE64_CHUNK_RE = /[A-Za-z0-9+/]{200,}={0,2}/;
const HEX_CHUNK_RE = /(?:[0-9a-fA-F]{2}){200,}/;

const LARGE_PAYLOAD_BYTES = 50 * 1024;   // 50KB
const ENCODED_PAYLOAD_BYTES = 4 * 1024;  // 4KB encoded blob is enough to exfil a lot

function flatStringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 256) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) flatStringValues(v, out, depth + 1);
  else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) flatStringValues(v, out, depth + 1);
  }
  return out;
}

function totalByteLength(strs: string[]): number {
  let n = 0;
  for (const s of strs) n += Buffer.byteLength(s, 'utf8');
  return n;
}

/**
 * Crude Shannon entropy on a string. Lower bound for "this looks
 * random/encoded". Base64-ish blobs land around 5.5+ bits/char; hex
 * around 4+; English text around 3.5-4.5.
 */
function shannonEntropy(s: string): number {
  if (s.length < 64) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function findEncodedChunk(strs: string[]): { sample?: string; entropy?: number; encoding?: 'base64' | 'hex' } {
  for (const s of strs) {
    if (s.length < ENCODED_PAYLOAD_BYTES) continue;
    const b64 = s.match(BASE64_CHUNK_RE);
    if (b64 && shannonEntropy(b64[0]) > 4.5) {
      return { sample: b64[0].slice(0, 80) + '…', entropy: shannonEntropy(b64[0]), encoding: 'base64' };
    }
    const hex = s.match(HEX_CHUNK_RE);
    if (hex && shannonEntropy(hex[0]) > 3.5) {
      return { sample: hex[0].slice(0, 80) + '…', entropy: shannonEntropy(hex[0]), encoding: 'hex' };
    }
  }
  return {};
}

export class ExfilDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'content' as const;
  readonly coverage = ['AAT-T5003', 'AAT-T5004', 'AAT-T5005'] as const;

  evaluate(ctx: DetectorContext): Signal[] {
    const isOutbound = OUTBOUND_TOOL_PATTERNS.some(p => p.test(ctx.tool.name));
    if (!isOutbound) return [];

    const strs = flatStringValues(ctx.tool.args);
    const out: Signal[] = [];

    // T5004 — Large-Payload Outbound
    const bytes = totalByteLength(strs);
    if (bytes >= LARGE_PAYLOAD_BYTES) {
      out.push(this.sig({
        node: 'AAT-T5004',
        severity: 'warn',
        category: 'exfil.large-payload',
        message: `${(bytes / 1024).toFixed(1)}KB outbound payload via ${ctx.tool.name}`,
        evidence: { tool: ctx.tool.name, payload_bytes: bytes, threshold_bytes: LARGE_PAYLOAD_BYTES },
      }));
    }

    // T5005 — Encoded / Obfuscated Exfil
    const enc = findEncodedChunk(strs);
    if (enc.sample) {
      out.push(this.sig({
        node: 'AAT-T5005',
        severity: 'critical',
        category: 'exfil.encoded',
        message: `high-entropy ${enc.encoding} blob (${enc.entropy?.toFixed(2)} bits/char) in outbound tool ${ctx.tool.name}`,
        evidence: {
          tool: ctx.tool.name,
          encoding: enc.encoding,
          entropy_bits_per_char: enc.entropy,
          sample: enc.sample,
        },
      }));
    }

    // T5003 — Upload to External Destination
    // We don't yet have an allow-list infra; the signal is informational
    // when a non-localhost outbound URL is present. Real allow-listing
    // lives in tenant_config (future). Coverage claimed as "we surface
    // it"; effective enforcement is a v1.1 add.
    const externalUrlHit = strs.some(s =>
      /https?:\/\/(?!(localhost|127\.0\.0\.1|::1)\b)/.test(s)
    );
    if (externalUrlHit && bytes < LARGE_PAYLOAD_BYTES && !enc.sample) {
      out.push(this.sig({
        node: 'AAT-T5003',
        severity: 'info',
        category: 'exfil.external-destination',
        message: `outbound to external destination via ${ctx.tool.name}`,
        evidence: { tool: ctx.tool.name, payload_bytes: bytes },
      }));
    }

    return out;
  }

  private sig(opts: { node: string; severity: Severity; category: string; message: string; evidence: Record<string, unknown> }): Signal {
    return {
      detector: NAME,
      version: VERSION,
      severity: opts.severity,
      category: opts.category,
      message: opts.message,
      evidence: opts.evidence,
      ontology: [opts.node],
    };
  }
}
