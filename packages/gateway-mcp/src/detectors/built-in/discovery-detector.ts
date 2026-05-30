/**
 * Discovery detector — flags reconnaissance-shaped tool calls.
 *
 * Coverage:
 *   AAT-T7001  Environment Enumeration  — tool calls asking for env
 *              vars, /proc, mount info, process listings.
 *   AAT-T7002  Credential Discovery     — file reads / globs hitting
 *              well-known credential paths (.ssh, .aws, *.pem, *.key,
 *              kubeconfig, service-account.json, etc.).
 *   AAT-T7003  Network Topology Mapping — calls to cloud-metadata
 *              endpoints (169.254.169.254, metadata.google.internal),
 *              internal-DNS probes, port scans.
 *
 * Heuristics, not ML — these patterns are well known and stable. False
 * positives (a legit ops agent listing env vars) become a tool-scope
 * problem the operator declares away; false negatives are the bigger
 * risk and the classifier + anomaly layer catches edge cases.
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';

const NAME = 'aegis.builtin.discovery';
const VERSION = '1.0.0';

// ── Pattern banks ─────────────────────────────────────────────────────────

// Tool names that smell like environment enumeration.
const ENV_TOOL_PATTERNS = [
  /^get_?env(_?vars?)?$/i,
  /^read_?env(_?vars?)?$/i,
  /^list_?env(_?vars?)?$/i,
  /^process_?list$/i,
  /^ps_?(aux|ef)?$/i,
  /^uname$/i,
  /^whoami$/i,
];

// String content in args suggesting env enumeration.
const ENV_CONTENT_PATTERNS = [
  /(^|\s|;|&)env(\s|$)/i,                   // shell `env`
  /(^|\s|;|&)printenv(\s|$)/i,
  /(^|\s|;|&)set\s*$/,                       // bash `set` (be conservative)
  /\/proc\/\d+\/environ/,
  /process\.env\b/,
  /\bos\.environ\b/,
];

// File paths / glob patterns that indicate credential discovery.
const CRED_PATH_PATTERNS = [
  /\.ssh\/(id_rsa|id_ed25519|id_dsa|id_ecdsa|authorized_keys|known_hosts)/i,
  /\.aws\/(credentials|config)/i,
  /\.azure\/(credentials|accessTokens)/i,
  /\.config\/gcloud\//i,
  /\.gnupg\//i,
  /\.docker\/config\.json/i,
  /\.npmrc/i,
  /\.netrc/i,
  /\.pypirc/i,
  /kubeconfig/i,
  /\bservice[_-]?account[_-].*\.json/i,
  /\b(id_rsa|id_ed25519)(?:\.pub)?\b/i,
  /\.(pem|key|p12|pfx)(\s|$|['"])/i,
  /\/etc\/(passwd|shadow|sudoers)/i,
];

// Tool name patterns that indicate file enumeration intent.
const FILE_ENUM_TOOL_PATTERNS = [
  /^(list|read|find|glob|grep|search)_?(file|dir|path)/i,
];

// Hosts / IPs that are cloud metadata services or internal-only.
const TOPOLOGY_HOST_PATTERNS = [
  /169\.254\.169\.254/,                      // AWS/GCP/Azure metadata
  /metadata\.google\.internal/i,
  /metadata\.azure\.com/i,
  /fd00:ec2::254/i,                          // AWS IMDSv2 IPv6
  /(\b|\/)(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+/,  // RFC1918
  /\.internal(\b|\/)/i,
  /\bconsul\b|\bnomad\b|\betcd\b/i,
];

const TOPOLOGY_TOOL_PATTERNS = [
  /^(nmap|netcat|nc|portscan|dig|nslookup)$/i,
  /^(http|fetch|request|get|post|curl|wget)/i, // generic; relies on host pattern hit
];

// ── helpers ──────────────────────────────────────────────────────────────

function flatStringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 256) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) flatStringValues(v, out, depth + 1);
  else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) flatStringValues(v, out, depth + 1);
  }
  return out;
}

function anyMatch(strs: string[], patterns: RegExp[]): { hit: boolean; sample?: string; pattern?: string } {
  for (const s of strs) {
    for (const p of patterns) {
      if (p.test(s)) return { hit: true, sample: s.slice(0, 120), pattern: p.source };
    }
  }
  return { hit: false };
}

// ── Detector ──────────────────────────────────────────────────────────────

export class DiscoveryDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'content' as const;
  readonly coverage = ['AAT-T7001', 'AAT-T7002', 'AAT-T7003'] as const;

  evaluate(ctx: DetectorContext): Signal[] {
    const strs = flatStringValues(ctx.tool.args);
    const out: Signal[] = [];

    // T7001 — Environment Enumeration
    const envToolHit = ENV_TOOL_PATTERNS.some(p => p.test(ctx.tool.name));
    const envContentHit = anyMatch(strs, ENV_CONTENT_PATTERNS);
    if (envToolHit || envContentHit.hit) {
      out.push(this.sig({
        node: 'AAT-T7001',
        severity: 'warn',
        category: 'discovery.environment-enumeration',
        message: `agent invoked ${ctx.tool.name} with apparent environment enumeration intent`,
        evidence: { tool: ctx.tool.name, sample: envContentHit.sample, pattern: envContentHit.pattern },
      }));
    }

    // T7002 — Credential Discovery
    const fileEnumTool = FILE_ENUM_TOOL_PATTERNS.some(p => p.test(ctx.tool.name));
    const credHit = anyMatch(strs, CRED_PATH_PATTERNS);
    if (credHit.hit && (fileEnumTool || credHit.hit)) {
      out.push(this.sig({
        node: 'AAT-T7002',
        severity: 'critical',
        category: 'discovery.credential-discovery',
        message: `credential-path target in tool call (${credHit.pattern})`,
        evidence: { tool: ctx.tool.name, sample: credHit.sample, pattern: credHit.pattern },
      }));
    }

    // T7003 — Network Topology Mapping
    const topoToolHit = TOPOLOGY_TOOL_PATTERNS.some(p => p.test(ctx.tool.name));
    const topoHostHit = anyMatch(strs, TOPOLOGY_HOST_PATTERNS);
    if (topoHostHit.hit) {
      out.push(this.sig({
        node: 'AAT-T7003',
        severity: 'critical',
        category: 'discovery.network-topology-mapping',
        message: `internal-network / metadata target in tool call (${topoHostHit.pattern})`,
        evidence: { tool: ctx.tool.name, sample: topoHostHit.sample, pattern: topoHostHit.pattern },
      }));
    } else if (topoToolHit && strs.length > 0) {
      // Scan-style tool call but no obvious internal host — still suspicious
      out.push(this.sig({
        node: 'AAT-T7003',
        severity: 'warn',
        category: 'discovery.network-topology-mapping',
        message: `scan-style tool ${ctx.tool.name} invoked`,
        evidence: { tool: ctx.tool.name },
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
