/**
 * SOC 2 evidence pack export.
 *
 * The audit-log surface (with attribution + filters + integrity
 * verification) lets a SOC 2 reviewer answer "who changed what,
 * when, and is the chain intact" inside the Cockpit. Eventually
 * the reviewer needs to *take a copy* away — a frozen snapshot to
 * attach to their working papers, share with an external auditor,
 * or hand to a regulator.
 *
 * `EvidencePackService.build(orgId)` produces one canonical JSON
 * document containing:
 *
 *   - meta            : version, generated_at, org_id, gateway version
 *   - audit_log       : every admin_audit_log row for this org
 *   - policies        : every policy active on this org
 *   - tenant_config   : the current TenantConfig snapshot (incl. DSL)
 *   - integrity       : bulk integrity verify result across all agents
 *   - trace_counts    : per-agent trace count + latest trace_id (the
 *                       full traces table can be massive; we surface
 *                       the linkage anchors instead of every row)
 *
 * Returning JSON (not tar.gz / zip) is a deliberate scope choice:
 * - zero new deps
 * - the document is self-contained and grep-able
 * - signing is unambiguous (canonical JSON → one SHA-256 input)
 *
 * A future v0.4.x adds the Ed25519 signature path (the gateway
 * already has the signing service); the pack format already
 * reserves a `signature` field for that.
 */

import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { IntegrityService } from './integrity';
import { SigningService, type SignaturePayload } from './signing';

const EVIDENCE_PACK_VERSION = '1.0';

export interface EvidencePack {
  meta: {
    version: string;
    generated_at: string;
    org_id: string;
    gateway_version: string;
    note: string;
  };
  audit_log: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  tenant_config: Record<string, unknown> | null;
  integrity: {
    total_agents: number;
    ok_agents: number;
    broken_agents: number;
    agents: Array<{
      agent_id: string;
      ok: boolean;
      total: number;
      broken_at?: unknown;
    }>;
    latency_ms: number;
  };
  trace_counts: Array<{
    agent_id: string;
    count: number;
    latest_trace_id: string | null;
    first_seen: string | null;
    last_seen: string | null;
  }>;
  /** Ed25519 detached signature over the canonical JSON of every
   *  other field. Self-contained — public_key_pem is bundled so
   *  the pack can be verified offline. */
  signature?: SignaturePayload;
}

/**
 * Canonical JSON form of a pack for signing/verification.
 * Strips out the signature field, then JSON.stringify with stable
 * key order (the constructor builds the object in fixed order, and
 * V8 JSON.stringify preserves insertion order). Producer + verifier
 * must use this exact function or the signature will not match.
 */
export function canonicalize(pack: EvidencePack): string {
  const { signature: _ignored, ...rest } = pack;
  return JSON.stringify(rest);
}

export interface EvidencePackOptions {
  /** Cap on rows returned per table — guards against the entire
   *  audit log spilling into memory on a busy gateway. The default
   *  (50_000) is well above what a typical SOC 2 review needs and
   *  still serializes in seconds. */
  maxRowsPerTable?: number;
  /** When true (default), sign the produced pack with the
   *  gateway's Ed25519 evidence-signing key. Set false to produce
   *  an unsigned snapshot — useful for internal pipelines that
   *  hash on their own terms. */
  sign?: boolean;
}

export class EvidencePackService {
  private signer: SigningService;

  constructor(
    private db: Database.Database,
    private logger?: Logger,
  ) {
    this.signer = new SigningService(db, logger);
  }

  build(orgId: string, opts: EvidencePackOptions = {}): EvidencePack {
    const cap = Math.max(1, Math.min(opts.maxRowsPerTable ?? 50_000, 500_000));

    // 1. Audit log scoped to this org.
    const auditRows = this.db
      .prepare(
        `SELECT id, org_id, user_id, user_email, action, resource_type,
                resource_id, details, ip_address, created_at
         FROM admin_audit_log
         WHERE org_id = ? OR org_id IS NULL
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(orgId, cap) as Array<{ details: string | null } & Record<string, unknown>>;
    const audit_log = auditRows.map((r) => ({
      ...r,
      details: r.details ? safeParseJson(r.details) : null,
    }));

    // 2. Policies (table is small; no cap needed in practice but
    // we still bound it to stay consistent).
    const policies: Array<Record<string, unknown>> = (() => {
      try {
        return this.db
          .prepare(`SELECT * FROM policies LIMIT ?`)
          .all(cap) as Array<Record<string, unknown>>;
      } catch (err) {
        // The policies table is schema-stable; if SELECT fails
        // something is very wrong but we don't want to nuke the
        // whole pack — flag it and continue.
        this.logger?.warn({ err }, 'evidence-pack: policies query failed');
        return [];
      }
    })();

    // 3. Tenant config — pulled from organizations.settings.
    let tenant_config: Record<string, unknown> | null = null;
    try {
      const row = this.db
        .prepare(`SELECT settings FROM organizations WHERE id = ?`)
        .get(orgId) as { settings: string | null } | undefined;
      if (row?.settings) tenant_config = safeParseJson(row.settings) as Record<string, unknown>;
    } catch {
      /* leave null if organizations table doesn't exist (community tier) */
    }

    // 4. Integrity sweep across all agents.
    const integritySvc = new IntegrityService(this.db, this.logger);
    const integrityFull = integritySvc.verifyAllAgents();
    const integrity = {
      total_agents: integrityFull.total_agents,
      ok_agents: integrityFull.ok_agents,
      broken_agents: integrityFull.broken_agents,
      agents: integrityFull.agents,
      latency_ms: integrityFull.latency_ms,
    };

    // 5. Per-agent trace count + anchors. Full trace export is left
    // out because it can be > 100MB on a busy deployment; the
    // anchors (first/last trace_id + count) plus the integrity
    // verdict are what a reviewer actually pins their report on.
    const trace_counts = this.db
      .prepare(
        `SELECT agent_id,
                COUNT(*) as count,
                MIN(timestamp) as first_seen,
                MAX(timestamp) as last_seen,
                (SELECT trace_id FROM traces t2
                 WHERE t2.agent_id = traces.agent_id
                 ORDER BY sequence_number DESC LIMIT 1) as latest_trace_id
         FROM traces
         GROUP BY agent_id
         ORDER BY agent_id ASC`,
      )
      .all() as Array<{
        agent_id: string;
        count: number;
        first_seen: string | null;
        last_seen: string | null;
        latest_trace_id: string | null;
      }>;

    const pack: EvidencePack = {
      meta: {
        version: EVIDENCE_PACK_VERSION,
        generated_at: new Date().toISOString(),
        org_id: orgId,
        gateway_version: '2.0.0',
        note: 'AEGIS SOC 2 evidence pack. Each section is a frozen snapshot at generated_at.',
      },
      audit_log,
      policies,
      tenant_config,
      integrity,
      trace_counts,
    };

    if (opts.sign !== false) {
      pack.signature = this.signer.sign(canonicalize(pack));
    }

    return pack;
  }

  /** Convenience for the /verify endpoint and CLI: returns true
   *  iff `pack.signature` is a valid Ed25519 over the canonical
   *  form of every other field. Strict: missing signature → false. */
  static verify(pack: EvidencePack): boolean {
    if (!pack.signature) return false;
    return SigningService.verify(canonicalize(pack), pack.signature);
  }

  /** Expose the gateway's current evidence-signing pubkey + key_id.
   *  Auditors who want extra paranoia can fetch this directly and
   *  compare against the public_key_pem embedded in a pack. */
  getPublicKey(): { key_id: string; public_key_pem: string } {
    return this.signer.getPublicKey();
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;  // Preserve the original string so nothing is lost.
  }
}
