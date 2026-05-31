/**
 * Deployment template registry REST API.
 *
 *   GET    /api/v1/templates              list (built-in + operator-registered)
 *   GET    /api/v1/templates/:id          template detail
 *   POST   /api/v1/templates              register a custom template
 *   DELETE /api/v1/templates/:id          remove a custom template (built-ins protected)
 *
 * /apply-template stays at /api/v1/config/apply-template (tenant-config
 * API) — the registry is the catalog, application is a tenant action.
 */

import { Router, Request, Response } from 'express';
import { CustomTemplateSpecSchema } from '@agentguard/core-schema';
import { TemplateRegistryService } from '../services/template-registry';

export class TemplatesAPI {
  readonly router: Router;

  constructor(private registry: TemplateRegistryService) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/', (_req: Request, res: Response) => {
      res.json({ templates: this.registry.list() });
    });

    this.router.get('/:id', (req: Request, res: Response) => {
      const t = this.registry.get(req.params.id);
      if (!t) return res.status(404).json({ error: 'unknown template', id: req.params.id });
      res.json(t);
    });

    this.router.post('/', (req: Request, res: Response) => {
      const parsed = CustomTemplateSpecSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid template spec', issues: parsed.error.issues });
      try {
        const stored = this.registry.register(parsed.data);
        res.status(201).json({ template: stored });
      } catch (err: any) {
        res.status(err.status ?? 500).json({ error: err.message });
      }
    });

    this.router.delete('/:id', (req: Request, res: Response) => {
      try {
        const removed = this.registry.delete(req.params.id);
        if (!removed) return res.status(404).json({ error: 'unknown template', id: req.params.id });
        res.status(204).end();
      } catch (err: any) {
        res.status(err.status ?? 500).json({ error: err.message });
      }
    });
  }
}
