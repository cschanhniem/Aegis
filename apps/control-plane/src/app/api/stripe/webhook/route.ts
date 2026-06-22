/**
 * Stripe webhook handler — every billing-relevant event lands here,
 * gets logged to billing_events, and updates orgs.plan / quota /
 * stripe_subscription_id.
 *
 * Configure in Stripe Dashboard → Developers → Webhooks:
 *   Endpoint URL:  https://app.aegis.dev/api/stripe/webhook
 *   Events:        checkout.session.completed
 *                  customer.subscription.created
 *                  customer.subscription.updated
 *                  customer.subscription.deleted
 *                  invoice.payment_failed
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { adminSql } from '@/lib/db'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-06-20',
})

const PLAN_BY_PRICE_ID: Record<string, { plan: string; quota: number; retention: number }> = {
  [process.env.STRIPE_PRICE_ID_PRO_MONTHLY  ?? '__missing__']: { plan: 'pro',  quota: 100_000,   retention: 30 },
  [process.env.STRIPE_PRICE_ID_PRO_ANNUAL   ?? '__missing__']: { plan: 'pro',  quota: 100_000,   retention: 30 },
  [process.env.STRIPE_PRICE_ID_TEAM_MONTHLY ?? '__missing__']: { plan: 'team', quota: 1_000_000, retention: 90 },
  [process.env.STRIPE_PRICE_ID_TEAM_ANNUAL  ?? '__missing__']: { plan: 'team', quota: 1_000_000, retention: 90 },
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'missing signature' }, { status: 400 })

  const body = await req.text()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET ?? '')
  } catch (err: any) {
    return NextResponse.json({ error: `signature verify failed: ${err.message}` }, { status: 400 })
  }

  // Idempotency: drop duplicates.
  const existing = await adminSql`SELECT 1 FROM billing_events WHERE stripe_event_id = ${event.id}`
  if (existing.count > 0) return NextResponse.json({ ok: true, deduped: true })

  await adminSql`
    INSERT INTO billing_events (stripe_event_id, event_type, payload, processed)
    VALUES (${event.id}, ${event.type}, ${event as any}, false)
  `

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const orgId = session.client_reference_id
        if (orgId && session.customer) {
          await adminSql`
            UPDATE orgs
               SET stripe_customer_id = ${String(session.customer)},
                   stripe_subscription_id = ${session.subscription ? String(session.subscription) : null}
             WHERE id = ${orgId}
          `
        }
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const priceId = sub.items.data[0]?.price.id
        const tier = priceId ? PLAN_BY_PRICE_ID[priceId] : undefined
        if (sub.customer && tier) {
          await adminSql`
            UPDATE orgs
               SET plan = ${tier.plan},
                   monthly_check_quota = ${tier.quota},
                   retention_days = ${tier.retention},
                   stripe_subscription_id = ${sub.id}
             WHERE stripe_customer_id = ${String(sub.customer)}
          `
        }
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        // Downgrade to free at period end.
        await adminSql`
          UPDATE orgs
             SET plan = 'free',
                 monthly_check_quota = 1000,
                 retention_days = 7
           WHERE stripe_customer_id = ${String(sub.customer)}
        `
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        await adminSql`
          UPDATE orgs
             SET suspended_at = NOW(),
                 suspended_reason = 'payment failed'
           WHERE stripe_customer_id = ${String(invoice.customer)}
        `
        break
      }
    }

    await adminSql`UPDATE billing_events SET processed = true WHERE stripe_event_id = ${event.id}`
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    await adminSql`
      UPDATE billing_events
         SET error = ${err.message}
       WHERE stripe_event_id = ${event.id}
    `
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}
