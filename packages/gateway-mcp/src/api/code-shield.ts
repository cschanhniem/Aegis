/**
 * CodeShield REST endpoint — POST /api/v1/code-shield/scan
 *
 * Fast (sub-millisecond) static checks for generated code. Used by
 * agents that write code (e.g. coding copilots) before they commit
 * or exec it. Findings can flow into the Policy DSL via the
 * `code_shield.*` context field.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { CodeShield, CodeShieldLanguage, DEFAULT_RULES } from '../services/code-shield';
import { AuditLogService } from '../services/audit-log';

const ScanRequestSchema = z.object({
  code: z.string().min(1).max(200_000),
  language: z
    .enum(['any', 'python', 'javascript', 'shell', 'sql'])
    .optional(),
  disabled_rules: z.array(z.string().max(80)).max(64).optional(),
  agent_id: z.string().max(128).optional(),
});

export class CodeShieldAPI {
  public router: Router;

  constructor(
    private logger: Logger,
    private auditLog: AuditLogService,
    private db?: Database.Database,
  ) {
    this.router = Router();
    const shield = new CodeShield(logger);

    this.router.post('/scan', (req: Request, res: Response) => {
      const parsed = ScanRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid scan request', details: parsed.error.issues });
      }
      try {
        const result = shield.scan(parsed.data.code, {
          language: parsed.data.language as CodeShieldLanguage | undefined,
          disabledRules: parsed.data.disabled_rules,
        });

        // Only audit-log when there's something to record — clean
        // scans on every keystroke would balloon the log.
        if (result.findings.length > 0) {
          this.auditLog.log({
            org_id: (req as any).orgId,
            action: 'judge.trace',
            resource_type: 'agent',
            resource_id: parsed.data.agent_id ?? 'unknown',
            details: {
              kind: 'code_shield',
              worst: result.worst,
              unique_findings: result.unique_findings,
              rules: Array.from(new Set(result.findings.map((f) => f.rule))),
            },
            ip_address: req.ip,
          });
        }

        res.json(result);
      } catch (err) {
        this.logger.error({ err }, 'code-shield scan failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    /**
     * GET /api/v1/code-shield/rules
     *
     * Returns the full rule catalog. CLI / Cockpit / SDKs can read
     * this to render an authoritative list without each surface
     * keeping its own hardcoded copy that drifts over time.
     */
    this.router.get('/rules', (_req: Request, res: Response) => {
      res.json({
        count: DEFAULT_RULES.length,
        rules: DEFAULT_RULES.map((r) => ({
          id: r.id,
          description: r.description,
          severity: r.severity,
          language: r.language,
          cwe: r.cwe,
          // We deliberately don't expose the regex source — keeps the
          // contract about what each rule *catches*, not how.
        })),
      });
    });

    /**
     * GET /api/v1/code-shield/recent?limit=20
     *
     * Pulls the most recent code-shield findings from admin_audit_log
     * (where kind='code_shield'), scoped to the caller's org. Mirrors
     * /alignment/recent so the Cockpit can render a panel without a
     * separate table.
     */
    this.router.get('/recent', (req: Request, res: Response) => {
      if (!this.db) {
        return res.status(503).json({ error: 'audit database unavailable' });
      }
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
      const orgId = (req as any).orgId ?? 'default';
      try {
        const rows = this.db
          .prepare(
            `SELECT id, org_id, user_email, action, resource_id, details, created_at
             FROM admin_audit_log
             WHERE action = 'judge.trace'
               AND org_id = ?
               AND json_extract(details, '$.kind') = 'code_shield'
             ORDER BY id DESC
             LIMIT ?`,
          )
          .all(orgId, limit) as Array<{
            id: number;
            org_id: string | null;
            user_email: string | null;
            resource_id: string | null;
            details: string;
            created_at: string;
          }>;

        const items = rows
          .map((r) => {
            try {
              const d = JSON.parse(r.details) as {
                kind?: string;
                worst?: string;
                unique_findings?: number;
                rules?: string[];
              };
              return {
                id: r.id,
                agent_id: r.resource_id,
                created_at: r.created_at,
                worst: d.worst ?? null,
                findings_count: typeof d.unique_findings === 'number' ? d.unique_findings : 0,
                rules: Array.isArray(d.rules) ? d.rules : [],
                user_email: r.user_email,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        res.json({ items, limit });
      } catch (err) {
        this.logger.error({ err }, 'code-shield recent query failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
