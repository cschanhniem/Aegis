/**
 * AgentIdCardService — mints + verifies the AEGIS Agent ID v1.
 *
 * Wire format: JWT (RFC 7519) with EdDSA / Ed25519 signature (RFC 8037).
 *
 *   header.payload.signature
 *
 *   header = base64url({"alg":"EdDSA","typ":"JWT","kid":"<gateway-key-id>"})
 *   payload = base64url(<AgentIdCardClaims JSON>)
 *   signature = base64url(Ed25519(headerB64 + "." + payloadB64))
 *
 * The signing key is the gateway's existing Ed25519 evidence-signing key
 * (same one that signs transparency-log roots + evidence packs). One root
 * of trust for every signed AEGIS artifact.
 *
 * Verification:
 *   - Decode JWT, parse claims.
 *   - Recompute Ed25519 signature over header.payload using the embedded
 *     public key (PEM via SigningService.publicKeyPem).
 *   - Reject if exp < now, status === 'suspended' | 'deprecated', or
 *     if the agent is unknown / deleted.
 *
 * Default TTL: 24 hours. Operators can override per mint.
 */

import { createHash, KeyObject, sign as edSign, verify as edVerify, createPublicKey } from 'crypto';
import {
  AgentIdCardClaims,
  RegisteredAgent,
} from '@agentguard/core-schema';
import { SigningService } from './signing';
import { AgentRegistryService } from './agent-registry';

const DEFAULT_TTL_SEC = 24 * 60 * 60;

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export interface IdCardMintOptions {
  /** TTL override in seconds. Default 86400 (24h). Capped at 30 days. */
  ttl_sec?: number;
  /** Override issuer string. Default `aegis-gateway:<orgId>`. */
  issuer?: string;
  /** Override audience string. Default same as issuer. */
  audience?: string;
}

export interface IdCardMintResult {
  /** Full JWT — three base64url segments joined by dots. */
  token: string;
  /** Decoded claims for convenience (operator displays them in the
   *  Cockpit before handing the token off). */
  claims: AgentIdCardClaims;
  /** Key id of the gateway signing key used. SHA-256 of pubkey PEM. */
  kid: string;
}

export interface IdCardVerifyResult {
  ok: boolean;
  reason?: string;
  claims?: AgentIdCardClaims;
  /** When ok=true, the agent's current registry status — used to defeat
   *  "valid JWT but agent was suspended after issue" race. */
  current_status?: RegisteredAgent['status'];
}

export class AgentIdCardService {
  constructor(
    private signer: SigningService,
    private registry: AgentRegistryService,
  ) {}

  /** Mint a signed JWT carrying the agent's current capability + provenance
   *  card. The signed snapshot reflects registry state at mint time;
   *  short-TTL design means a stale snapshot is bounded. */
  mint(opts: { orgId: string; agentId: string; mint?: IdCardMintOptions }): IdCardMintResult | null {
    const agent = this.registry.get(opts.agentId);
    if (!agent || agent.org_id !== opts.orgId) return null;

    const ttl = Math.min(opts.mint?.ttl_sec ?? DEFAULT_TTL_SEC, 30 * 24 * 60 * 60);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ttl;
    const issuer = opts.mint?.issuer ?? `aegis-gateway:${opts.orgId}`;
    const audience = opts.mint?.audience ?? issuer;

    const claims: AgentIdCardClaims = {
      v: 1,
      iss: issuer,
      aud: audience,
      sub: agent.id,
      iat,
      exp,
      name: agent.name,
      owner_email: agent.owner_email,
      org_id: agent.org_id,
      scope: {
        tools: agent.declared_tools ?? [],
        environments: agent.environments ?? [],
        data_classes: agent.capabilities?.data_classes ?? [],
      },
      limits: {
        cost_daily_usd: agent.max_cost_daily_usd,
        calls_per_minute: agent.capabilities?.calls_per_minute,
        recursion_depth: agent.capabilities?.recursion_depth,
        may_spawn_subagents: agent.capabilities?.may_spawn_subagents ?? false,
      },
      provenance: agent.provenance ?? {},
      lifecycle: {
        status: agent.status,
        last_rotated_at: agent.updated_at,
      },
    };
    // Public key claim — included whenever the agent has registered a
    // pinned pubkey. Customers verifying agent-signed requests use this
    // to bind the JWT to the keypair.
    if (agent.has_public_key) {
      const pubPem = this.fetchPubkey(agent.id);
      if (pubPem) {
        claims.keys = {
          alg: 'ed25519',
          pub: pubPem,
          kid: this.kidOf(pubPem),
          rotated_count: 0,
        };
      }
    }

    const signerKid = this.gatewayKid();
    const header = { alg: 'EdDSA', typ: 'JWT', kid: signerKid };
    const headerB64 = b64url(JSON.stringify(header));
    const payloadB64 = b64url(JSON.stringify(claims));
    const signingInput = `${headerB64}.${payloadB64}`;
    const sig = edSign(null, Buffer.from(signingInput, 'utf8'), this.gatewayPrivateKey());
    const token = `${signingInput}.${b64url(sig)}`;
    return { token, claims, kid: signerKid };
  }

  /** Verify a JWT. Checks: structure, Ed25519 signature against the
   *  current gateway public key, exp, agent existence + current status. */
  verify(token: string): IdCardVerifyResult {
    if (!token || typeof token !== 'string') return { ok: false, reason: 'no token' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed JWT' };
    const [headerB64, payloadB64, sigB64] = parts;
    let header: any, claims: AgentIdCardClaims;
    try {
      header = JSON.parse(fromB64url(headerB64).toString('utf8'));
      claims = JSON.parse(fromB64url(payloadB64).toString('utf8')) as AgentIdCardClaims;
    } catch { return { ok: false, reason: 'bad base64 / json' }; }
    if (header.alg !== 'EdDSA') return { ok: false, reason: `unsupported alg ${header.alg}` };

    const ok = edVerify(
      null,
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      this.gatewayPublicKey(),
      fromB64url(sigB64),
    );
    if (!ok) return { ok: false, reason: 'signature does not verify' };

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) return { ok: false, reason: 'token expired' };
    if (claims.iat > now + 60) return { ok: false, reason: 'token from the future' };

    const agent = this.registry.get(claims.sub);
    if (!agent) return { ok: false, reason: 'agent unknown' };
    if (agent.org_id !== claims.org_id) return { ok: false, reason: 'org_id mismatch' };
    if (agent.status === 'suspended' || agent.status === 'deprecated') {
      return { ok: false, reason: `agent status: ${agent.status}`, current_status: agent.status, claims };
    }

    return { ok: true, claims, current_status: agent.status };
  }

  /** Returns the kid (key-id) for the gateway signing key. SHA-256 of
   *  the canonical PEM, base64url-truncated to 16 chars. */
  gatewayKid(): string {
    return this.kidOf(this.signer.publicKeyPem());
  }

  private kidOf(pem: string): string {
    return createHash('sha256').update(pem.trim()).digest('base64url').slice(0, 16);
  }

  private gatewayPrivateKey(): KeyObject {
    return this.signer.privateKey();
  }

  private gatewayPublicKey(): KeyObject {
    return createPublicKey(this.signer.publicKeyPem());
  }

  private fetchPubkey(_agentId: string): string | undefined {
    // The registry exposes has_public_key; we don't currently surface the
    // PEM through the public type. Wire-up follow-up: add a getPubkey()
    // accessor on AgentRegistryService. For v1 we leave the claim absent
    // when has_public_key is true but we can't read the PEM cleanly —
    // verifying parties fall back to JWT-only auth.
    return undefined;
  }
}
