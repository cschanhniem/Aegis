/**
 * Ontology + Coverage REST API.
 *
 *   GET /api/v1/ontology                  → frozen taxonomy (version + nodes)
 *   GET /api/v1/ontology/tactics          → just the 10 top-level tactics
 *   GET /api/v1/ontology/coverage         → coverage summary (ratio + per-tactic + per-node)
 *   GET /api/v1/ontology/coverage/:nodeId → which detectors cover a single node
 *   GET /api/v1/ontology/detectors/:name  → which nodes a given detector claims
 *
 * Read-only and stateless — safe to make public if a customer wants the
 * taxonomy itself, but the coverage endpoints carry detector names so we
 * mount this under requireAuth in server.ts.
 */

import { Router, Request, Response } from 'express';
import {
  TACTICS,
  TECHNIQUES,
  ONTOLOGY_VERSION,
  getNode,
} from '@agentguard/core-schema';
import { CoverageMapService } from '../services/coverage-map';

export class OntologyAPI {
  readonly router: Router;

  constructor(private coverage: CoverageMapService) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/', (_req: Request, res: Response) => {
      res.json({
        version: ONTOLOGY_VERSION,
        tactics: TACTICS,
        techniques: TECHNIQUES,
      });
    });

    this.router.get('/tactics', (_req: Request, res: Response) => {
      res.json({ version: ONTOLOGY_VERSION, tactics: TACTICS });
    });

    this.router.get('/coverage', (_req: Request, res: Response) => {
      res.json(this.coverage.summary());
    });

    this.router.get('/coverage/:nodeId', (req: Request, res: Response) => {
      const node = getNode(req.params.nodeId);
      if (!node) {
        return res.status(404).json({ error: { code: 'UNKNOWN_NODE', node_id: req.params.nodeId } });
      }
      const fwd = this.coverage.forwardMap();
      res.json({
        node,
        coveringDetectors: fwd.get(node.id) ?? [],
      });
    });

    this.router.get('/detectors/:name', (req: Request, res: Response) => {
      const rev = this.coverage.reverseMap();
      const claimed = rev.get(req.params.name);
      if (!claimed) {
        return res.status(404).json({ error: { code: 'UNKNOWN_DETECTOR', name: req.params.name } });
      }
      res.json({
        detector: req.params.name,
        coverage: claimed.map(id => getNode(id)).filter(Boolean),
      });
    });
  }
}
