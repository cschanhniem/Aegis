/**
 * Ed25519 detached signing service for the gateway.
 *
 * Used by the evidence-pack exporter to sign the JSON bundle so a
 * SOC 2 auditor can verify offline that the file they received
 * hasn't been mutated since the gateway produced it. The keypair
 * is generated on first use and persisted in `gateway_config`
 * (key=`evidence_signing_private_key` / `_public_key` / `_key_id`)
 * so the same identity persists across restarts.
 *
 * Why Ed25519 and not RSA/ECDSA:
 *   - 64-byte sigs, 32-byte pubkeys — pack stays compact.
 *   - Node 22's `crypto` builtin supports it natively (no dep).
 *   - Deterministic by spec — same input + key → same signature,
 *     useful for reproducibility tests.
 *
 * Key identity: an 8-char hex prefix of SHA-256 over the pubkey
 * PEM bytes. Lets an auditor compare key_ids across multiple
 * packs from the same gateway without diff-ing 32-byte raw values.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'crypto';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';

export interface SignaturePayload {
  algorithm: 'ed25519';
  key_id: string;
  /** base64 signature over the canonical JSON input. */
  signature: string;
  /** PEM-encoded public key so the pack is self-verifiable
   *  without re-contacting the gateway. */
  public_key_pem: string;
}

interface KeyState {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
  keyId: string;
}

export class SigningService {
  private state: KeyState | null = null;

  constructor(
    private db: Database.Database,
    private logger?: Logger,
  ) {}

  /** Returns the in-memory keypair, loading from gateway_config or
   *  generating + persisting on first use. */
  private ensureKey(): KeyState {
    if (this.state) return this.state;

    const get = (k: string): string | null => {
      try {
        const row = this.db
          .prepare(`SELECT value FROM gateway_config WHERE key = ?`)
          .get(k) as { value: string } | undefined;
        return row?.value ?? null;
      } catch {
        return null;  // table not present in old schema variant
      }
    };
    const put = (k: string, v: string): void => {
      try {
        this.db
          .prepare(
            `INSERT INTO gateway_config (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(k, v);
      } catch (err) {
        this.logger?.warn({ err, key: k }, 'signing: gateway_config put failed');
      }
    };

    const privPem = get('evidence_signing_private_key');
    const pubPem = get('evidence_signing_public_key');
    const keyId = get('evidence_signing_key_id');

    if (privPem && pubPem && keyId) {
      const privateKey = createPrivateKey(privPem);
      const publicKey = createPublicKey(pubPem);
      this.state = { privateKey, publicKey, publicKeyPem: pubPem, keyId };
      return this.state;
    }

    // First use — generate.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const newPrivPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const newPubPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const newKeyId = createHash('sha256').update(newPubPem).digest('hex').slice(0, 16);

    put('evidence_signing_private_key', newPrivPem);
    put('evidence_signing_public_key', newPubPem);
    put('evidence_signing_key_id', newKeyId);

    this.logger?.info({ key_id: newKeyId }, 'signing: generated new evidence-pack Ed25519 keypair');

    this.state = {
      privateKey,
      publicKey,
      publicKeyPem: newPubPem,
      keyId: newKeyId,
    };
    return this.state;
  }

  /** Sign a Buffer / string and return a self-contained payload. */
  sign(data: Buffer | string): SignaturePayload {
    const key = this.ensureKey();
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const sig = cryptoSign(null, bytes, key.privateKey);
    return {
      algorithm: 'ed25519',
      key_id: key.keyId,
      signature: sig.toString('base64'),
      public_key_pem: key.publicKeyPem,
    };
  }

  /** Static verify — no DB / instance state needed. Returns true
   *  iff the signature is a valid Ed25519 over data using
   *  public_key_pem. Misuse-resistant: any malformed input → false,
   *  no exceptions surfaced to the caller. */
  static verify(
    data: Buffer | string,
    payload: { signature: string; public_key_pem: string },
  ): boolean {
    try {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      const pub = createPublicKey(payload.public_key_pem);
      const sigBuf = Buffer.from(payload.signature, 'base64');
      return cryptoVerify(null, bytes, pub, sigBuf);
    } catch {
      return false;
    }
  }

  /** Expose pubkey + key_id for the public-key endpoint. */
  getPublicKey(): { key_id: string; public_key_pem: string } {
    const { keyId, publicKeyPem } = this.ensureKey();
    return { key_id: keyId, public_key_pem: publicKeyPem };
  }

  /** PEM-encoded public key. Convenience accessor for components (e.g.
   *  AgentIdCardService) that need the raw PEM string for kid derivation
   *  or claim embedding. */
  publicKeyPem(): string {
    return this.ensureKey().publicKeyPem;
  }

  /** Underlying Ed25519 private key. ONLY used inside the gateway process
   *  by services that need to call crypto.sign() directly (e.g. JWT
   *  signing). Never serialized; never leaves the runtime. */
  privateKey(): KeyObject {
    return this.ensureKey().privateKey;
  }
}
