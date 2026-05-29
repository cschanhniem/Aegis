import {
  TACTICS,
  TECHNIQUES,
  ONTOLOGY_VERSION,
  getNode,
  isValidNodeId,
  listTechniquesFor,
  allNodes,
} from '@agentguard/core-schema';
import { DetectorRegistry } from '../detectors/registry';
import { PiiDetector } from '../detectors/built-in/pii-detector';
import { ClassifierDetector } from '../detectors/built-in/classifier-detector';
import { CoverageMapService } from '../services/coverage-map';

describe('AEGIS Agent Threat Ontology', () => {
  it('exports a frozen v1.0.0 with 10 tactics', () => {
    expect(ONTOLOGY_VERSION).toBe('1.0.0');
    expect(TACTICS).toHaveLength(10);
    // Frozen at module load — assignment should silently fail in strict
    // mode; we test by checking the canonical shape didn't drift.
    expect(TACTICS.map(t => t.slug).sort()).toEqual([
      'credential-access',
      'data-exfiltration',
      'defense-evasion',
      'discovery',
      'execution',
      'impact',
      'initial-compromise',
      'lateral-movement',
      'persistence',
      'privilege-escalation',
    ]);
  });

  it('every technique points at a real tactic', () => {
    const slugs = new Set(TACTICS.map(t => t.slug));
    for (const tech of TECHNIQUES) {
      expect(slugs.has(tech.tactic)).toBe(true);
    }
  });

  it('every node ID follows the AAT-T<n> scheme and is unique', () => {
    const seen = new Set<string>();
    for (const n of allNodes()) {
      expect(n.id).toMatch(/^AAT-T\d+$/);
      expect(seen.has(n.id)).toBe(false);
      seen.add(n.id);
    }
  });

  it('getNode + isValidNodeId agree with the canonical list', () => {
    for (const n of allNodes()) {
      expect(getNode(n.id)).toBe(n);
      expect(isValidNodeId(n.id)).toBe(true);
    }
    expect(getNode('AAT-T9999')).toBeUndefined();
    expect(isValidNodeId('not-a-real-id')).toBe(false);
  });

  it('listTechniquesFor returns only that tactic', () => {
    const credAccess = listTechniquesFor('credential-access');
    expect(credAccess.length).toBeGreaterThan(0);
    expect(credAccess.every(t => t.tactic === 'credential-access')).toBe(true);
  });
});

describe('CoverageMapService', () => {
  function makeRegistry(): DetectorRegistry {
    const r = new DetectorRegistry();
    r.register(new PiiDetector());
    r.register(new ClassifierDetector());
    return r;
  }

  it('forwardMap covers every node a built-in claims', () => {
    const svc = new CoverageMapService(makeRegistry());
    const fwd = svc.forwardMap();
    // PiiDetector claims AAT-T4001 (Secret in Tool Arguments)
    expect(fwd.get('AAT-T4001')?.map(d => d.name)).toContain('aegis.builtin.pii');
    // ClassifierDetector claims AAT-T2004 (SQL Injection)
    expect(fwd.get('AAT-T2004')?.map(d => d.name)).toContain('aegis.builtin.classifier');
  });

  it('reverseMap returns each detector\'s claimed coverage', () => {
    const svc = new CoverageMapService(makeRegistry());
    const rev = svc.reverseMap();
    const pii = rev.get('aegis.builtin.pii');
    expect(pii).toBeDefined();
    expect(pii).toContain('AAT-T4001');
    expect(pii).toContain('AAT-T4003');
  });

  it('summary reports per-tactic + overall ratio', () => {
    const svc = new CoverageMapService(makeRegistry());
    const summary = svc.summary();
    expect(summary.ontologyVersion).toBe('1.0.0');
    expect(summary.totalNodes).toBe(TECHNIQUES.length);
    expect(summary.coveredNodes).toBeGreaterThan(0);
    expect(summary.coverageRatio).toBeGreaterThan(0);
    expect(summary.coverageRatio).toBeLessThanOrEqual(1);
    // perTactic must include every tactic that has at least one technique
    expect(summary.perTactic.length).toBe(10);
  });

  it('drops detector coverage claims pointing at unknown ontology IDs', () => {
    const r = new DetectorRegistry();
    r.register({
      name: 'test.bogus',
      version: '1',
      kind: 'content',
      coverage: ['AAT-T9999', 'AAT-T4001'],   // first is fake, second is real
      evaluate() { return []; },
    });
    const svc = new CoverageMapService(r);
    const fwd = svc.forwardMap();
    expect(fwd.get('AAT-T9999')).toBeUndefined();
    expect(fwd.get('AAT-T4001')?.[0]?.name).toBe('test.bogus');
  });

  it('tenant-supplied detector extends published coverage', () => {
    const r = new DetectorRegistry();
    r.register(new PiiDetector());
    const before = new CoverageMapService(r).summary().coveredNodes;
    r.register({
      name: 'tenant.exfil',
      version: '0.1',
      kind: 'content',
      coverage: ['AAT-T5001', 'AAT-T5003', 'AAT-T5004'],
      evaluate() { return []; },
    });
    const after = new CoverageMapService(r).summary().coveredNodes;
    expect(after).toBeGreaterThan(before);
  });
});
