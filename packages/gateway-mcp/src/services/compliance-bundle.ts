/**
 * ComplianceBundleService — for each control in a chosen framework, runs
 * the control's evidence query against AEGIS state (audit log,
 * detectors, transparency log) and assembles a signed bundle.
 *
 * The output is:
 *   1. Auditor-ready — every control has a clear coverage status and the
 *      raw evidence that produced it.
 *   2. Cryptographically verifiable — bundle hash is signed with the
 *      gateway's Ed25519 evidence key and appended to the transparency
 *      log so the customer can prove "AEGIS generated THIS bundle on
 *      THIS date" without having to trust AEGIS later.
 *   3. Reproducible — given the same gateway state, the bundle is
 *      deterministic (audit counts, ontology coverage). The only varying
 *      field is `generated_at`.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { allNodes, isValidNodeId, ONTOLOGY_VERSION } from '@agentguard/core-schema';
import { ComplianceControl, controlsFor, Framework } from './compliance-controls';
import { DetectorRegistry } from '../detectors/registry';
import { CoverageMapService } from './coverage-map';
import { SigningService, SignaturePayload } from './signing';
import { TransparencyLogService } from './transparency-log';

export type ControlStatus = 'covered' | 'partial' | 'uncovered';

export interface ControlEvidence {
  audit_action_counts?: Record<string, number>;
  detectors_registered?: Array<{ name: string; version: string }>;
  ontology_coverage?: {
    total: number;
    covered: number;
    nodes: Array<{ id: string; covered: boolean; covering_detectors: string[] }>;
  };
  artifacts?: {
    transparency_root?: { tree_size: number; root_hash: string; timestamp: string };
    audit_row_count?: number;
  };
}

export interface BundleControl {
  id: string;
  framework: Framework;
  title: string;
  summary: string;
  status: ControlStatus;
  evidence: ControlEvidence;
}

export interface ComplianceBundle {
  framework: Framework;
  org_id: string;
  generated_at: string;
  ontology_version: string;
  controls: BundleControl[];
  summary: {
    total_controls: number;
    covered: number;
    partial: number;
    uncovered: number;
  };
  bundle_hash: string;       // sha256 hex of canonical body
  signature: SignaturePayload;
  transparency_log_entry?: { index: number; tree_size: number };
}

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

export class ComplianceBundleService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
    private detectors: DetectorRegistry,
    private coverageMap: CoverageMapService,
    private signer: SigningService,
    private transparency?: TransparencyLogService,
  ) {}

  generate(opts: { framework: Framework; orgId: string }): ComplianceBundle {
    const controls = controlsFor(opts.framework);
    const fwd = this.coverageMap.forwardMap();
    const registered = this.detectors.list();
    const registeredNames = new Set(registered.map(d => d.name));

    const bundleControls: BundleControl[] = controls.map(ctrl =>
      this.assembleControl(ctrl, opts.orgId, fwd, registered, registeredNames),
    );

    const summary = {
      total_controls: bundleControls.length,
      covered:    bundleControls.filter(c => c.status === 'covered').length,
      partial:    bundleControls.filter(c => c.status === 'partial').length,
      uncovered:  bundleControls.filter(c => c.status === 'uncovered').length,
    };

    const bodyForHash = {
      framework: opts.framework,
      org_id: opts.orgId,
      ontology_version: ONTOLOGY_VERSION,
      controls: bundleControls,
      summary,
    };
    const canonical = canonicalJson(bodyForHash);
    const bundleHash = require('crypto').createHash('sha256').update(canonical, 'utf8').digest('hex');
    const signature = this.signer.sign(canonical);

    let transparencyEntry: { index: number; tree_size: number } | undefined;
    if (this.transparency) {
      try {
        const r = this.transparency.append({
          payload: bodyForHash,
          source: 'evidence-pack',
          org_id: opts.orgId,
        });
        const treeSize = this.transparency.size();
        transparencyEntry = { index: r.index, tree_size: treeSize };
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, framework: opts.framework },
          'transparency append failed for compliance bundle',
        );
      }
    }

    return {
      framework: opts.framework,
      org_id: opts.orgId,
      generated_at: new Date().toISOString(),
      ontology_version: ONTOLOGY_VERSION,
      controls: bundleControls,
      summary,
      bundle_hash: bundleHash,
      signature,
      transparency_log_entry: transparencyEntry,
    };
  }

  private assembleControl(
    ctrl: ComplianceControl,
    orgId: string,
    fwd: Map<string, Array<{ name: string; version: string }>>,
    registered: ReturnType<DetectorRegistry['list']>,
    registeredNames: Set<string>,
  ): BundleControl {
    const ev: ControlEvidence = {};

    // Audit action counts (scoped to org).
    if (ctrl.evidenceSpec.auditActions?.length) {
      ev.audit_action_counts = {};
      for (const action of ctrl.evidenceSpec.auditActions) {
        try {
          const row = this.db.prepare(
            `SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = ? AND (org_id = ? OR org_id IS NULL)`,
          ).get(action, orgId) as { n: number };
          ev.audit_action_counts[action] = Number(row.n) || 0;
        } catch {
          ev.audit_action_counts[action] = 0;
        }
      }
    }

    // Detector registration check.
    if (ctrl.evidenceSpec.detectors?.length) {
      ev.detectors_registered = ctrl.evidenceSpec.detectors
        .filter(n => registeredNames.has(n))
        .map(n => {
          const d = registered.find(r => r.name === n)!;
          return { name: d.name, version: d.version };
        });
    }

    // Ontology coverage subset.
    if (ctrl.evidenceSpec.ontology?.length) {
      const nodes = ctrl.evidenceSpec.ontology.filter(isValidNodeId).map(id => ({
        id,
        covered: fwd.has(id),
        covering_detectors: (fwd.get(id) ?? []).map(d => d.name),
      }));
      ev.ontology_coverage = {
        total: nodes.length,
        covered: nodes.filter(n => n.covered).length,
        nodes,
      };
    }

    // Artifacts — transparency root + total audit row count.
    if (ctrl.evidenceSpec.artifacts?.length) {
      ev.artifacts = {};
      if (ctrl.evidenceSpec.artifacts.includes('transparency-root') && this.transparency) {
        const signed = this.transparency.signedRoot();
        if (signed) {
          ev.artifacts.transparency_root = {
            tree_size: signed.tree_size,
            root_hash: signed.root_hash,
            timestamp: signed.timestamp,
          };
        }
      }
      if (ctrl.evidenceSpec.artifacts.includes('audit-row-count')) {
        try {
          const row = this.db.prepare(
            `SELECT COUNT(*) AS n FROM admin_audit_log WHERE org_id = ? OR org_id IS NULL`,
          ).get(orgId) as { n: number };
          ev.artifacts.audit_row_count = Number(row.n) || 0;
        } catch {
          ev.artifacts.audit_row_count = 0;
        }
      }
    }

    return {
      id: ctrl.id,
      framework: ctrl.framework,
      title: ctrl.title,
      summary: ctrl.summary,
      status: classify(ev, ctrl),
      evidence: ev,
    };
  }
}

function classify(ev: ControlEvidence, ctrl: ComplianceControl): ControlStatus {
  // No evidence collected → uncovered.
  const hasAnyEvidence =
    (ev.audit_action_counts && Object.values(ev.audit_action_counts).some(n => n > 0)) ||
    (ev.detectors_registered && ev.detectors_registered.length > 0) ||
    (ev.ontology_coverage && ev.ontology_coverage.covered > 0) ||
    (ev.artifacts && (ev.artifacts.audit_row_count || ev.artifacts.transparency_root));
  if (!hasAnyEvidence) return 'uncovered';

  // Full coverage: every spec section is fully satisfied.
  const detectorsSpec = ctrl.evidenceSpec.detectors;
  const detectorsFull = !detectorsSpec || (
    ev.detectors_registered && ev.detectors_registered.length === detectorsSpec.length
  );
  const ontologyFull = !ev.ontology_coverage
    || ev.ontology_coverage.covered === ev.ontology_coverage.total;
  return detectorsFull && ontologyFull ? 'covered' : 'partial';
}

export { allNodes };
