/**
 * CoverageMapService — joins the live DetectorRegistry against the frozen
 * AEGIS Agent Threat Ontology to produce a runtime coverage table.
 *
 * Two queries customers care about:
 *   1. "Which ontology nodes does my AEGIS instance cover?"
 *      → forwardMap(): node ID → covering detectors
 *   2. "What does this detector claim to cover?"
 *      → reverseMap(): detector name → node IDs
 *
 * Coverage is the union of every registered detector's `coverage` field.
 * Tenant-supplied detectors contribute the same way built-ins do — that's
 * the point: customers extend coverage without forking us.
 */

import {
  allNodes,
  isValidNodeId,
  ONTOLOGY_VERSION,
  OntologyNode,
} from '@agentguard/core-schema';
import { DetectorRegistry } from '../detectors/registry';

export interface CoverageEntry {
  readonly nodeId: string;
  readonly title: string;
  readonly tactic: string;
  readonly covered: boolean;
  readonly coveringDetectors: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
}

export interface CoverageSummary {
  readonly ontologyVersion: string;
  readonly totalNodes: number;
  readonly coveredNodes: number;
  readonly coverageRatio: number;     // 0..1
  readonly perTactic: ReadonlyArray<{
    readonly tactic: string;
    readonly total: number;
    readonly covered: number;
  }>;
  readonly entries: ReadonlyArray<CoverageEntry>;
}

export class CoverageMapService {
  constructor(private registry: DetectorRegistry) {}

  forwardMap(): Map<string, Array<{ name: string; version: string }>> {
    const out = new Map<string, Array<{ name: string; version: string }>>();
    for (const d of this.registry.list()) {
      for (const nodeId of d.coverage ?? []) {
        if (!isValidNodeId(nodeId)) continue;   // detector claimed an unknown ID — drop, don't fabricate
        const arr = out.get(nodeId) ?? [];
        arr.push({ name: d.name, version: d.version });
        out.set(nodeId, arr);
      }
    }
    return out;
  }

  reverseMap(): Map<string, ReadonlyArray<string>> {
    const out = new Map<string, ReadonlyArray<string>>();
    for (const d of this.registry.list()) {
      out.set(d.name, [...(d.coverage ?? [])].filter(isValidNodeId));
    }
    return out;
  }

  summary(): CoverageSummary {
    const fwd = this.forwardMap();
    const nodes = allNodes().filter(n => n.kind === 'technique') as Extract<OntologyNode, { kind: 'technique' }>[];

    const entries: CoverageEntry[] = nodes.map(n => ({
      nodeId: n.id,
      title: n.title,
      tactic: n.tactic,
      covered: fwd.has(n.id),
      coveringDetectors: fwd.get(n.id) ?? [],
    }));

    const perTacticMap = new Map<string, { total: number; covered: number }>();
    for (const e of entries) {
      const row = perTacticMap.get(e.tactic) ?? { total: 0, covered: 0 };
      row.total += 1;
      if (e.covered) row.covered += 1;
      perTacticMap.set(e.tactic, row);
    }
    const perTactic = [...perTacticMap.entries()].map(([tactic, v]) => ({
      tactic, total: v.total, covered: v.covered,
    }));

    const coveredNodes = entries.filter(e => e.covered).length;

    return {
      ontologyVersion: ONTOLOGY_VERSION,
      totalNodes: entries.length,
      coveredNodes,
      coverageRatio: entries.length === 0 ? 0 : coveredNodes / entries.length,
      perTactic,
      entries,
    };
  }
}
