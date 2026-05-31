/**
 * Ontology + Coverage REST API.
 *
 *   GET    /api/v1/ontology                       canonical taxonomy
 *   GET    /api/v1/ontology/tactics               just the 10 top-level tactics
 *   GET    /api/v1/ontology/coverage              coverage summary (per-tenant)
 *   GET    /api/v1/ontology/coverage/:nodeId      detectors covering one node
 *   GET    /api/v1/ontology/detectors/:name       nodes a detector claims
 *   GET    /api/v1/ontology/nodes                 tenant TENANT.* nodes
 *   POST   /api/v1/ontology/nodes                 add a TENANT.* node
 *   DELETE /api/v1/ontology/nodes/:id             remove a TENANT.* node
 *
 * Coverage endpoints are tenant-aware: TENANT.* nodes registered by the
 * caller's org show up in the summary alongside canonical AAT-T* nodes.
 */

import { Router, Request, Response } from 'express';
import {
  TACTICS,
  TECHNIQUES,
  ONTOLOGY_VERSION,
  getNode,
  TenantOntologyNodeSchema,
} from '@agentguard/core-schema';
import { CoverageMapService } from '../services/coverage-map';
import { TenantConfigService } from '../services/tenant-config';

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}

export class OntologyAPI {
  readonly router: Router;

  constructor(
    private coverage: CoverageMapService,
    private tenantConfig: TenantConfigService,
  ) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/', (_req: Request, res: Response) => {
      res.json({ version: ONTOLOGY_VERSION, tactics: TACTICS, techniques: TECHNIQUES });
    });

    this.router.get('/tactics', (_req: Request, res: Response) => {
      res.json({ version: ONTOLOGY_VERSION, tactics: TACTICS });
    });

    this.router.get('/coverage', (req: Request, res: Response) => {
      res.json(this.coverage.summary(orgIdOf(req)));
    });

    this.router.get('/coverage/:nodeId', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const id = req.params.nodeId;
      // Canonical first; fall back to tenant nodes.
      let nodePayload: any = getNode(id);
      if (!nodePayload) {
        const tn = (this.tenantConfig.get(orgId).ontologyNodes ?? []).find(n => n.id === id);
        if (tn) nodePayload = { ...tn, kind: 'technique', source: 'tenant' };
      }
      if (!nodePayload) return res.status(404).json({ error: { code: 'UNKNOWN_NODE', node_id: id } });
      const fwd = this.coverage.forwardMap(orgId);
      res.json({ node: nodePayload, coveringDetectors: fwd.get(id) ?? [] });
    });

    this.router.get('/detectors/:name', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const rev = this.coverage.reverseMap(orgId);
      const claimed = rev.get(req.params.name);
      if (!claimed) {
        return res.status(404).json({ error: { code: 'UNKNOWN_DETECTOR', name: req.params.name } });
      }
      const tenantNodes = this.tenantConfig.get(orgId).ontologyNodes ?? [];
      const resolveNode = (id: string) => getNode(id) ?? tenantNodes.find(n => n.id === id);
      res.json({
        detector: req.params.name,
        coverage: claimed.map(resolveNode).filter(Boolean),
      });
    });

    // ── Tenant ontology nodes (TENANT.*) ────────────────────────────────

    this.router.get('/nodes', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      res.json({ nodes: this.tenantConfig.get(orgId).ontologyNodes ?? [] });
    });

    this.router.post('/nodes', (req: Request, res: Response) => {
      const parsed = TenantOntologyNodeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid node', issues: parsed.error.issues });
      const orgId = orgIdOf(req);
      const cfg = this.tenantConfig.get(orgId);
      const next = (cfg.ontologyNodes ?? []).filter(n => n.id !== parsed.data.id).concat(parsed.data);
      this.tenantConfig.update(orgId, { ontologyNodes: next }, { userEmail: 'api' });
      res.status(201).json({ node: parsed.data });
    });

    this.router.delete('/nodes/:id', (req: Request, res: Response) => {
      const orgId = orgIdOf(req);
      const cfg = this.tenantConfig.get(orgId);
      const next = (cfg.ontologyNodes ?? []).filter(n => n.id !== req.params.id);
      this.tenantConfig.update(orgId, { ontologyNodes: next }, { userEmail: 'api' });
      res.status(204).end();
    });
  }
}
