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
import { CodeShield, CodeShieldLanguage } from '../services/code-shield';
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
  }
}
