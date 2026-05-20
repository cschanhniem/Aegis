/**
 * Alignment auditor REST endpoint.
 *
 *   POST /api/v1/alignment/check
 *   body: AlignmentInput + optional { provider, model, api_key }
 *
 * Provider configuration falls back to env vars (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY) when the body doesn't include one
 * — matches the convention used by the existing LLM judge.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import {
  AlignmentChecker,
  AlignmentConfig,
  AlignmentProvider,
} from '../services/alignment-checker';
import { AuditLogService } from '../services/audit-log';

const RequestSchema = z.object({
  agent_id: z.string().min(1).max(128),
  declared_goal: z.string().min(1).max(4096),
  thought_chain: z.array(z.string().max(2048)).max(64).default([]),
  proposed_action: z.object({
    tool_name: z.string().min(1).max(128),
    arguments: z.record(z.unknown()),
  }),
  // Optional overrides
  provider: z.enum(['anthropic', 'openai', 'gemini']).optional(),
  model: z.string().max(80).optional(),
  api_key: z.string().min(8).max(512).optional(),
});

function resolveConfig(
  body: z.infer<typeof RequestSchema>,
): AlignmentConfig | { error: string } {
  const provider: AlignmentProvider =
    body.provider ??
    (process.env.ANTHROPIC_API_KEY
      ? 'anthropic'
      : process.env.OPENAI_API_KEY
        ? 'openai'
        : process.env.GEMINI_API_KEY
          ? 'gemini'
          : 'anthropic');

  const envKey =
    provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : provider === 'openai'
        ? process.env.OPENAI_API_KEY
        : process.env.GEMINI_API_KEY;

  const apiKey = body.api_key ?? envKey;
  if (!apiKey) {
    return {
      error: `No API key for provider '${provider}'. Set ${provider.toUpperCase()}_API_KEY or pass api_key in the request body.`,
    };
  }
  return {
    provider,
    apiKey,
    model: body.model,
  };
}

export class AlignmentAPI {
  public router: Router;

  constructor(
    private logger: Logger,
    private auditLog: AuditLogService,
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.post('/check', async (req: Request, res: Response) => {
      const parsed = RequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid request', details: parsed.error.issues });
      }
      const cfgOrErr = resolveConfig(parsed.data);
      if ('error' in cfgOrErr) {
        return res.status(400).json({ error: cfgOrErr.error });
      }

      const checker = new AlignmentChecker(cfgOrErr, this.logger);
      try {
        // Zod ran with .min(1) / required fields, so the parsed object
        // satisfies AlignmentInput at runtime; TS doesn't carry that
        // refinement so we cast.
        const result = await checker.check(parsed.data as any);

        // Audit log every check — alignment scores are evidence that
        // belongs in the compliance trail.
        this.auditLog.log({
          org_id: (req as any).orgId,
          action: 'judge.trace',
          resource_type: 'agent',
          resource_id: parsed.data.agent_id,
          details: {
            kind: 'alignment',
            score: result.score,
            drifted: result.drifted,
            signals: result.signals,
            model: result.model,
          },
          ip_address: req.ip,
        });

        return res.json(result);
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn(
          { agent_id: parsed.data.agent_id, err: msg },
          'alignment check failed',
        );
        return res.status(502).json({ error: msg });
      }
    });
  }
}
