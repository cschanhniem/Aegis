/**
 * Stripe webhook handler — keeps `org_subscriptions` in sync with
 * Stripe's lifecycle events.
 *
 * Stripe → POST /api/v1/stripe/webhook → we verify the signature,
 * extract the event type, and call the appropriate BillingStore
 * upsert. No outbound Stripe API call is made from here — Stripe
 * pushes everything we need.
 *
 * Events we handle:
 *   customer.subscription.created
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *   invoice.payment_succeeded   (mark active)
 *   invoice.payment_failed      (mark past_due)
 *
 * Other events are 200-ok'd silently so Stripe stops retrying — we
 * don't error on unrecognised events, that's expected behaviour.
 *
 * Stripe SDK is intentionally NOT a hard dependency. We do raw
 * signature verification with the standard `Stripe-Signature` header
 * format so this works whether the operator has the `stripe` npm
 * package installed or not. (Production SaaS will want the SDK; OSS
 * self-hosters who'll never use Stripe shouldn't be forced to install
 * the dep.)
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { createHmac, timingSafeEqual } from 'crypto';
import type { BillingStore, PlanId, SubscriptionStatus } from '../db/billing-store';

/** Map a Stripe price-id / lookup-key to one of our internal plan ids.
 *  Configure via env vars so you don't have to redeploy when Stripe
 *  prices rotate. */
function planForPrice(priceLookup: string | undefined): PlanId {
  if (!priceLookup) return 'free';
  if (priceLookup === process.env.STRIPE_PRICE_PRO)  return 'pro';
  if (priceLookup === process.env.STRIPE_PRICE_TEAM) return 'team';
  if (priceLookup === process.env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
  // Convention: lookup keys like 'aegis-pro-monthly' / 'aegis-team-annual'.
  const lower = priceLookup.toLowerCase();
  if (lower.includes('pro')) return 'pro';
  if (lower.includes('team')) return 'team';
  if (lower.includes('enterprise')) return 'enterprise';
  return 'free';
}

/** Stripe sends subscription status as one of a fixed enum. Map it to
 *  our local SubscriptionStatus enum directly — they're already
 *  compatible. */
function mapStatus(s: string | undefined): SubscriptionStatus {
  const valid: SubscriptionStatus[] = ['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid'];
  return (valid as string[]).includes(s ?? '') ? (s as SubscriptionStatus) : 'incomplete';
}

/** Verify Stripe's `Stripe-Signature` HMAC-SHA256 envelope. Returns
 *  the parsed event JSON when valid, throws otherwise. */
function verifySignature(rawBody: string, sigHeader: string, secret: string): any {
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {} as Record<string, string>);
  if (!parts.t || !parts.v1) throw new Error('malformed Stripe-Signature');
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
  const sigBuf = Buffer.from(parts.v1, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('signature mismatch');
  }
  return JSON.parse(rawBody);
}

/** Pull the org_id off the Stripe customer / subscription object. We
 *  set it as customer.metadata.org_id at signup time. Without it we
 *  can't route the event. */
function orgIdOf(obj: any): string | null {
  return obj?.metadata?.org_id ?? obj?.customer?.metadata?.org_id ?? null;
}

export class StripeWebhookAPI {
  router: Router;
  constructor(
    private store: BillingStore,
    private logger: Logger,
    private webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '',
  ) {
    this.router = Router();
    // Stripe webhooks MUST receive the raw body for signature
    // verification. We register an inline raw-body parser scoped to
    // this route so the global JSON parser doesn't consume it first.
    this.router.post('/webhook',
      (req, _res, next) => {
        // express.raw is registered when the route is mounted; if the
        // mounter forgot, we fall back to assembling from chunks.
        if ((req as any).rawBody) return next();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          (req as any).rawBody = Buffer.concat(chunks).toString('utf8');
          next();
        });
      },
      this.handle.bind(this),
    );
  }

  private async handle(req: Request, res: Response): Promise<void> {
    const rawBody = (req as any).rawBody as string | undefined;
    const sig = req.header('stripe-signature') ?? '';
    if (!rawBody) { res.status(400).json({ error: 'missing body' }); return; }
    if (!this.webhookSecret) {
      this.logger.warn('Stripe webhook hit but STRIPE_WEBHOOK_SECRET unset — ignoring');
      res.status(503).json({ error: 'stripe not configured' });
      return;
    }

    let event: any;
    try {
      event = verifySignature(rawBody, sig, this.webhookSecret);
    } catch (err: any) {
      this.logger.warn({ err: err.message }, 'Stripe webhook signature check failed');
      res.status(400).json({ error: 'invalid signature' });
      return;
    }

    const type: string = event.type;
    const data = event.data?.object ?? {};
    const orgId = orgIdOf(data);

    try {
      switch (type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          if (!orgId) {
            this.logger.warn({ type, sub_id: data.id }, 'subscription event with no org_id metadata');
            break;
          }
          const item = data.items?.data?.[0];
          const plan = planForPrice(item?.price?.lookup_key ?? item?.price?.id);
          await this.store.upsertSubscription({
            org_id: orgId,
            plan,
            status: mapStatus(data.status),
            stripe_customer_id: data.customer ?? null,
            stripe_subscription_id: data.id ?? null,
            current_period_start: data.current_period_start
              ? new Date(data.current_period_start * 1000).toISOString()
              : null,
            current_period_end: data.current_period_end
              ? new Date(data.current_period_end * 1000).toISOString()
              : null,
            cancel_at_period_end: data.cancel_at_period_end ? 1 : 0,
          });
          this.logger.info({ org_id: orgId, plan, status: data.status }, 'subscription synced');
          break;
        }
        case 'customer.subscription.deleted': {
          if (!orgId) break;
          const sub = await this.store.getSubscription(orgId);
          await this.store.upsertSubscription({
            ...sub,
            plan: 'free',
            status: 'canceled',
            cancel_at_period_end: 0,
          });
          break;
        }
        case 'invoice.payment_succeeded': {
          if (!orgId) break;
          const sub = await this.store.getSubscription(orgId);
          if (sub.status === 'past_due' || sub.status === 'unpaid') {
            await this.store.upsertSubscription({ ...sub, status: 'active' });
          }
          break;
        }
        case 'invoice.payment_failed': {
          if (!orgId) break;
          const sub = await this.store.getSubscription(orgId);
          await this.store.upsertSubscription({ ...sub, status: 'past_due' });
          break;
        }
        default:
          // Unknown event — 200 to stop retries.
          break;
      }
    } catch (err: any) {
      this.logger.error({ err: err.message, type }, 'Stripe handler failed');
      // Still 200 so Stripe doesn't keep retrying a deterministic bug.
      // Bug reports go through the operator's error tracker.
    }
    res.json({ received: true });
  }
}
