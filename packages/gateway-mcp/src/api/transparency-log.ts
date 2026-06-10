/**
 * Transparency Log REST API.
 *
 *   GET /api/v1/transparency-log/root           latest signed root
 *   GET /api/v1/transparency-log/stats          { tree_size, latest_root }
 *   GET /api/v1/transparency-log/entry/:idx     payload + leaf hash at 1-indexed idx
 *   GET /api/v1/transparency-log/proof/:idx     inclusion proof + signed root
 *
 * Verifier convention: the caller fetches /entry/:idx + /proof/:idx, hashes
 * the canonical payload with prefix 0x00, walks the proof to recompute the
 * root, and checks the Ed25519 signature against public_key_pem returned
 * in signed_root.signature.
 */

import { Router, Request, Response } from 'express';
import { TransparencyLogService } from '../services/transparency-log';

export class TransparencyLogAPI {
  readonly router: Router;

  constructor(private tlog: TransparencyLogService) {
    this.router = Router();
    this.routes();
  }

  private routes(): void {
    this.router.get('/root', (req: Request, res: Response) => {
      const treeSize = req.query.tree_size
        ? Number(req.query.tree_size)
        : undefined;
      const signed = this.tlog.signedRoot(treeSize);
      if (!signed) return res.status(404).json({ error: { code: 'EMPTY_LOG' } });
      res.json(signed);
    });

    this.router.get('/stats', (_req: Request, res: Response) => {
      const treeSize = this.tlog.size();
      const latest = treeSize > 0 ? this.tlog.signedRoot(treeSize) : null;
      res.json({ tree_size: treeSize, latest_root: latest });
    });

    this.router.get('/entry/:idx', (req: Request, res: Response) => {
      const idx = Number(req.params.idx);
      if (!Number.isFinite(idx) || idx < 1) {
        return res.status(400).json({ error: { code: 'BAD_INDEX' } });
      }
      const entry = this.tlog.getEntry(idx);
      if (!entry) return res.status(404).json({ error: { code: 'UNKNOWN_INDEX', index: idx } });
      res.json(entry);
    });

    this.router.get('/proof/:idx', (req: Request, res: Response) => {
      const idx = Number(req.params.idx);
      const treeSize = req.query.tree_size ? Number(req.query.tree_size) : undefined;
      if (!Number.isFinite(idx) || idx < 1) {
        return res.status(400).json({ error: { code: 'BAD_INDEX' } });
      }
      const proof = this.tlog.getProof(idx, treeSize);
      if (!proof) return res.status(404).json({ error: { code: 'UNKNOWN_INDEX', index: idx } });
      res.json(proof);
    });

    /**
     * GET /transparency-log/proof-by-hash?hash=<hex>&tree_size=N
     *
     * Inclusion proof for a leaf identified by its hash. Useful when the
     * consumer has the hash (from their archive) but not the log index.
     */
    this.router.get('/proof-by-hash', (req: Request, res: Response) => {
      const hash = typeof req.query.hash === 'string' ? req.query.hash : '';
      const treeSize = req.query.tree_size ? Number(req.query.tree_size) : undefined;
      if (!/^[0-9a-f]{64}$/i.test(hash)) {
        return res.status(400).json({ error: { code: 'BAD_HASH', detail: 'hash must be 64-char hex (SHA-256)' } });
      }
      const proof = this.tlog.getProofByHash(hash, treeSize);
      if (!proof) return res.status(404).json({ error: { code: 'NOT_FOUND', hash } });
      res.json(proof);
    });

    /**
     * GET /transparency-log/consistency?first=M&second=N
     *
     * RFC 6962 §2.1.2 consistency proof — the keystone for detecting
     * silent log forks. The consumer archives signed roots over time
     * and can audit any pair by calling this endpoint.
     */
    this.router.get('/consistency', (req: Request, res: Response) => {
      const first  = Number(req.query.first);
      const second = req.query.second ? Number(req.query.second) : undefined;
      if (!Number.isFinite(first) || first < 0) {
        return res.status(400).json({ error: { code: 'BAD_FIRST', detail: 'first must be >= 0' } });
      }
      if (second !== undefined && (!Number.isFinite(second) || second < first)) {
        return res.status(400).json({ error: { code: 'BAD_SECOND', detail: 'second must be >= first' } });
      }
      const proof = this.tlog.getConsistencyProof(first, second);
      if (!proof) return res.status(404).json({ error: { code: 'OUT_OF_RANGE' } });
      res.json(proof);
    });
  }
}
