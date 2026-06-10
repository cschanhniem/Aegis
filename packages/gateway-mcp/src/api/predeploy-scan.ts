/**
 * Pre-deployment scan REST surface. One endpoint:
 *
 *   POST /api/v1/scan/repo
 *   { path: "/absolute/path/to/repo", max?: number, extra?: string[] }
 *
 * Auth is the standard requireAuth in server.ts. Path must be
 * absolute — the wizard / CLI is responsible for resolving the
 * operator's local checkout; the gateway only accepts what's already
 * absolute (no traversal surface in this endpoint).
 *
 * When agent-audit is not installed, the endpoint returns 412
 * Precondition Failed with `binary_missing: true` and an install
 * hint, so the cockpit UI can render a "install via pipx" CTA
 * instead of a generic 500.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import { isAbsolute } from 'path';

import { PredeployScanService } from '../services/predeploy-scan';
import { ScanHistoryService } from '../services/scan-history';
import { diffFindings } from '../services/scan-diff';

const ScanBodySchema = z.object({
  path:  z.string().min(1).max(4096),
  max:   z.number().int().positive().max(5000).optional(),
  extra: z.array(z.string().max(80)).max(20).optional(),
}).strict();

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}
function actorOf(req: Request) {
  return {
    user_id: (req as any).sessionUser?.id ?? (req as any).keyPrefix,
    user_email: (req as any).sessionUser?.email ?? (req as any).keyName,
    ip_address: req.ip,
  };
}

export class PredeployScanAPI {
  router: Router;

  constructor(
    private svc: PredeployScanService,
    private history: ScanHistoryService,
    private logger: Logger,
  ) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // History endpoints register FIRST — Express picks longest static
    // prefix, so /history won't be eaten by /repo.
    this.router.get('/history',           this.listHistory.bind(this));
    this.router.get('/history/:id',       this.getHistory.bind(this));
    this.router.get('/history/:id.sarif', this.getHistorySarif.bind(this));
    this.router.get('/diff',              this.diff.bind(this));
    this.router.post('/repo',             this.scan.bind(this));
    this.router.post('/repo.sarif',       this.scanSarif.bind(this));
    this.router.get('/repo.sarif',        this.scanSarif.bind(this));
  }

  private listHistory(req: Request, res: Response): void {
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const path  = typeof req.query.path  === 'string' ? req.query.path  : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = this.history.list({ orgId: orgIdOf(req), since, path, limit });
    res.json({ scans: rows });
  }

  private getHistory(req: Request, res: Response): void {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const row = this.history.get({ orgId: orgIdOf(req), id });
    if (!row) { res.status(404).json({ error: 'scan not found' }); return; }
    res.json(row);
  }

  /** GET /diff?base=<id>&compare=<id> — return the partition
   *  added/removed/persisted between two saved scans. */
  private diff(req: Request, res: Response): void {
    const baseId = Number(req.query.base);
    const compareId = Number(req.query.compare);
    if (!Number.isFinite(baseId) || !Number.isFinite(compareId)) {
      res.status(400).json({ error: 'base + compare query params must both be numeric scan ids' });
      return;
    }
    const orgId = orgIdOf(req);
    const base    = this.history.get({ orgId, id: baseId });
    const compare = this.history.get({ orgId, id: compareId });
    if (!base)    { res.status(404).json({ error: `base scan ${baseId} not found` }); return; }
    if (!compare) { res.status(404).json({ error: `compare scan ${compareId} not found` }); return; }
    const result = diffFindings(base.findings ?? [], compare.findings ?? []);
    res.json({
      base:    { id: base.id, scanned_at: base.scanned_at, scan_path: base.scan_path },
      compare: { id: compare.id, scanned_at: compare.scanned_at, scan_path: compare.scan_path },
      ...result,
    });
  }

  private getHistorySarif(req: Request, res: Response): void {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const row = this.history.get({ orgId: orgIdOf(req), id });
    if (!row) { res.status(404).json({ error: 'scan not found' }); return; }
    if (!row.sarif) { res.status(404).json({ error: 'no SARIF retained for this scan' }); return; }
    res.setHeader('Content-Type', 'application/sarif+json');
    res.setHeader('Content-Disposition', `attachment; filename="aegis-scan-${id}.sarif"`);
    res.send(JSON.stringify(row.sarif, null, 2));
  }

  private async scan(req: Request, res: Response): Promise<void> {
    const parsed = ScanBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }
    if (!isAbsolute(parsed.data.path)) {
      res.status(400).json({ error: 'path must be absolute' });
      return;
    }
    try {
      const out = await this.svc.scan({
        orgId: orgIdOf(req),
        path:  parsed.data.path,
        max:   parsed.data.max,
        extra: parsed.data.extra,
        actor: actorOf(req),
      });
      if (!out.ok) {
        // 412 when the prerequisite binary is missing — actionable for the operator
        // 502 when the subprocess ran but produced unparseable output
        const missing = 'binary_missing' in out && out.binary_missing === true;
        res.status(missing ? 412 : 502).json(out);
        return;
      }
      // Persist the scan so the UI can list / diff / re-export later.
      const scanId = this.history.ingest({
        orgId: orgIdOf(req),
        scannedBy: actorOf(req).user_email ?? actorOf(req).user_id ?? null,
        report: out,
      });
      res.status(200).json({ ...out, scan_id: scanId });
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'predeploy scan failed');
      res.status(500).json({ error: err.message ?? 'internal error' });
    }
  }

  /**
   * Run a scan and return the *raw SARIF v2.1.0 document* so external
   * tools (GitHub Code Scanning upload, GitLab SAST report ingest,
   * Sonarqube) can consume it byte-for-byte.
   *
   * Two access modes:
   *   POST /repo.sarif  with JSON body { path, max?, extra? }
   *   GET  /repo.sarif?path=/abs/path   (CI convenience; URL-encoded path)
   */
  private async scanSarif(req: Request, res: Response): Promise<void> {
    // GET uses query params; POST uses body.
    const raw = req.method === 'GET'
      ? { path: typeof req.query.path === 'string' ? req.query.path : '',
          max:  req.query.max  ? Number(req.query.max)  : undefined }
      : req.body ?? {};
    const parsed = ScanBodySchema.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
      return;
    }
    if (!isAbsolute(parsed.data.path)) {
      res.status(400).json({ error: 'path must be absolute' });
      return;
    }
    try {
      const out = await this.svc.scan({
        orgId: orgIdOf(req),
        path:  parsed.data.path,
        max:   parsed.data.max,
        extra: parsed.data.extra,
        actor: actorOf(req),
      });
      if (!out.ok) {
        const missing = 'binary_missing' in out && out.binary_missing === true;
        res.status(missing ? 412 : 502).json(out);
        return;
      }
      this.history.ingest({
        orgId: orgIdOf(req),
        scannedBy: actorOf(req).user_email ?? actorOf(req).user_id ?? null,
        report: out,
      });
      // SARIF MIME type per OASIS spec
      res.setHeader('Content-Type', 'application/sarif+json');
      res.setHeader('Content-Disposition', `attachment; filename="scan-${Date.now()}.sarif"`);
      res.status(200).send(JSON.stringify(out.sarif ?? {}, null, 2));
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'predeploy scan failed');
      res.status(500).json({ error: err.message ?? 'internal error' });
    }
  }
}
