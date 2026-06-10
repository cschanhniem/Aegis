/**
 * Witness REST API:
 *
 *   POST /witnesses                 register an external witness pubkey (operator only)
 *   GET  /witnesses                 list registered witnesses
 *   POST /witnesses/:id/deactivate  retire a witness
 *
 *   GET  /witness/sth-to-sign       canonical STH bytes the witness must sign
 *   POST /witness/:id/cosign        witness submits its signature
 *   GET  /witness/signatures        consumer-side: cosignatures for a given root_hash
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import { WitnessService } from '../services/witness';

const RegisterBody = z.object({
  name: z.string().min(1).max(80),
  public_key_pem: z.string().min(20).max(8192),
}).strict();

const CosignBody = z.object({
  tree_size: z.number().int().nonnegative(),
  root_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  timestamp: z.string().min(1),
  signature: z.string().min(8).max(1024),
}).strict();

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}

export class WitnessAPI {
  router: Router;
  constructor(private svc: WitnessService, private logger: Logger) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Operator: register/list/deactivate
    this.router.post('/witnesses',                this.register.bind(this));
    this.router.get('/witnesses',                 this.list.bind(this));
    this.router.post('/witnesses/:id/deactivate', this.deactivate.bind(this));

    // Public + witness-facing
    this.router.get('/witness/sth-to-sign', this.sthToSign.bind(this));
    this.router.post('/witness/:id/cosign', this.cosign.bind(this));
    this.router.get('/witness/signatures',  this.signatures.bind(this));
  }

  private register(req: Request, res: Response): void {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid body', issues: parsed.error.issues }); return; }
    try {
      const w = this.svc.register({
        orgId: orgIdOf(req),
        name: parsed.data.name,
        public_key_pem: parsed.data.public_key_pem,
      });
      res.status(201).json(w);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  private list(req: Request, res: Response): void {
    res.json({ witnesses: this.svc.list(orgIdOf(req)) });
  }

  private deactivate(req: Request, res: Response): void {
    const ok = this.svc.deactivate({ orgId: orgIdOf(req), id: req.params.id });
    if (!ok) { res.status(404).json({ error: 'witness not found' }); return; }
    res.json({ ok: true });
  }

  /**
   * Returns the canonical STH bytes the witness must sign with its
   * Ed25519 key. We expose the canonical JSON STRING — not pretty-
   * printed — so the witness signs an unambiguous byte sequence.
   *
   * `sth` includes the metadata; `signing_bytes` is what to feed into
   * Ed25519. The witness must NOT reconstruct the bytes themselves
   * from the metadata (canonical JSON serialization can vary).
   */
  private sthToSign(req: Request, res: Response): void {
    const sth = this.svc.currentSth();
    if (!sth) { res.status(404).json({ error: 'log is empty' }); return; }
    const signing_bytes = WitnessService.canonicalSthBytes({
      tree_size: sth.tree_size,
      root_hash: sth.root_hash,
      timestamp: sth.timestamp,
    });
    res.json({ sth, signing_bytes });
  }

  private cosign(req: Request, res: Response): void {
    const parsed = CosignBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid body', issues: parsed.error.issues }); return; }
    const out = this.svc.cosign({
      orgId: orgIdOf(req),
      witness_id: req.params.id,
      tree_size: parsed.data.tree_size,
      root_hash: parsed.data.root_hash,
      timestamp: parsed.data.timestamp,
      signature: parsed.data.signature,
    });
    res.status(out.ok ? 200 : 400).json(out);
  }

  private signatures(req: Request, res: Response): void {
    const root_hash = typeof req.query.root_hash === 'string' ? req.query.root_hash : '';
    if (!/^[0-9a-f]{64}$/i.test(root_hash)) {
      res.status(400).json({ error: 'root_hash must be 64-char hex' });
      return;
    }
    res.json({ root_hash, cosignatures: this.svc.signaturesFor(orgIdOf(req), root_hash) });
  }
}
