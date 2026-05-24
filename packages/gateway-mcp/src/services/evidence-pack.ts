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
  /** Reserved for v0.4.x Ed25519 detached signature. */
  signature?: { algorithm: 'ed25519'; key_id: string; signature: string };
}

export interface EvidencePackOptions {
  /** Cap on rows returned per table — guards against the entire
   *  audit log spilling into memory on a busy gateway. The default
   *  (50_000) is well above what a typical SOC 2 review needs and
   *  still serializes in seconds. */
  maxRowsPerTable?: number;
}

export class EvidencePackService {
  constructor(
    private db: Database.Database,
    private logger?: Logger,
  ) {}

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

    return {
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
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;  // Preserve the original string so nothing is lost.
  }
}
