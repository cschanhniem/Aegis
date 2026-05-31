/**
 * Compliance bundle REST API.
 *
 *   GET    /api/v1/compliance/frameworks          list (built-in + tenant-custom)
 *   POST   /api/v1/compliance/frameworks          register a custom framework
 *   GET    /api/v1/compliance/frameworks/:id      framework detail
 *   DELETE /api/v1/compliance/frameworks/:id      remove a custom framework
 *   GET    /api/v1/compliance/controls/:fw        list a framework's controls
 *   POST   /api/v1/compliance/bundle/:fw          generate a signed bundle
 *
 * Custom frameworks live in tenant_config.customComplianceFrameworks[] —
 * stored alongside DSL, sinks, custom detectors. Hot-reloaded by the
 * config bus. Built-in IDs (`soc2|iso27001|nist-ai-rmf|eu-ai-act`)
 * cannot be shadowed.
 */

import { Router, Request, Response } from 'express';
import {
  CustomComplianceFrameworkSchema,
  RESERVED_FRAMEWORK_IDS,
} from '@agentguard/core-schema';
import {
  builtinControlsFor,
  isBuiltinFramework,
} from '../services/compliance-controls';
import { ComplianceControlSource } from '../services/compliance-source';
import { ComplianceBundleService } from '../services/compliance-bundle';
import { AuditLogService } from '../services/audit-log';
import { TenantConfigService } from '../services/tenant-config';

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}

export class ComplianceAPI {
  readonly router: Router;

  constructor(
    private bundles: ComplianceBundleService,
    private audit: AuditLogService,
    private source: ComplianceControlSource,
    private tenantConfig: TenantConfigService,
  ) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/frameworks', (req: Request, res: Response) => {
      res.json({ frameworks: this.source.list(orgIdOf(req)) });
    });

    this.router.post('/frameworks', (req: Request, res: Response) => {
      const parsed = CustomComplianceFrameworkSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid spec', issues: parsed.error.issues });
      if (RESERVED_FRAMEWORK_IDS.includes(parsed.data.id)) {
        return res.status(409).json({ error: 'framework id is reserved for built-in', id: parsed.data.id });
      }
      const orgId = orgIdOf(req);
      const cfg = this.tenantConfig.get(orgId);
      const existing = cfg.customComplianceFrameworks ?? [];
      const next = existing.filter(f => f.id !== parsed.data.id).concat(parsed.data);
      this.tenantConfig.update(orgId, { customComplianceFrameworks: next }, { userEmail: 'api' });
      this.audit.log({
        org_id: orgId,
        action: 'tenant.config.update',
        resource_type: 'system',
        resource_id: `compliance-framework:${parsed.data.id}`,
        details: { control_count: parsed.data.controls.length },
        ip_address: req.ip,
      });
      res.status(201).json({ framework: parsed.data });
    });

    this.router.get('/frameworks/:id', (req: Request, res: Response) => {
      const id = req.params.id;
      const orgId = orgIdOf(req);
      if (isBuiltinFramework(id)) {
        return res.json({
          id, source: 'builtin', controls: builtinControlsFor(id as any),
        });
      }
      const custom = (this.tenantConfig.get(orgId).customComplianceFrameworks ?? []).find(f => f.id === id);
      if (!custom) return res.status(404).json({ error: 'unknown framework' });
      res.json({ ...custom, source: 'custom' });
    });

    this.router.delete('/frameworks/:id', (req: Request, res: Response) => {
      const id = req.params.id;
      if (RESERVED_FRAMEWORK_IDS.includes(id)) {
        return res.status(400).json({ error: 'cannot delete a built-in framework', id });
      }
      const orgId = orgIdOf(req);
      const cfg = this.tenantConfig.get(orgId);
      const next = (cfg.customComplianceFrameworks ?? []).filter(f => f.id !== id);
      this.tenantConfig.update(orgId, { customComplianceFrameworks: next }, { userEmail: 'api' });
      res.status(204).end();
    });

    this.router.get('/controls/:framework', (req: Request, res: Response) => {
      const fw = req.params.framework;
      const orgId = orgIdOf(req);
      if (!this.source.exists(orgId, fw)) return res.status(404).json({ error: 'unknown framework' });
      res.json({ framework: fw, controls: this.source.controlsFor(orgId, fw) });
    });

    this.router.post('/bundle/:framework', (req: Request, res: Response) => {
      const fw = req.params.framework;
      const orgId = orgIdOf(req);
      if (!this.source.exists(orgId, fw)) return res.status(404).json({ error: 'unknown framework' });
      const bundle = this.bundles.generate({ framework: fw, orgId });
      this.audit.log({
        org_id: orgId,
        action: 'data.export',
        resource_type: 'system',
        resource_id: `compliance-bundle:${fw}`,
        ip_address: req.ip,
        details: {
          framework: fw,
          bundle_hash: bundle.bundle_hash,
          controls: bundle.summary,
          transparency_log_index: bundle.transparency_log_entry?.index,
        },
      });
      res.json(bundle);
    });
  }
}
