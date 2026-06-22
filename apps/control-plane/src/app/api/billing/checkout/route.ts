/**
 * Stripe Checkout session creator. Called by the cockpit's "Upgrade
 * to Pro" / "Upgrade to Team" buttons.
 *
 * Body: { orgId, plan: 'pro' | 'team', interval: 'month' | 'year' }
 * Returns: { url } — redirect the browser to this.
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { adminSql } from '@/lib/db'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-06-20',
})

const PRICE_BY_PLAN_INTERVAL: Record<string, string | undefined> = {
  'pro:month':   process.env.STRIPE_PRICE_ID_PRO_MONTHLY,
  'pro:year':    process.env.STRIPE_PRICE_ID_PRO_ANNUAL,
  'team:month':  process.env.STRIPE_PRICE_ID_TEAM_MONTHLY,
  'team:year':   process.env.STRIPE_PRICE_ID_TEAM_ANNUAL,
}

export async function POST(req: NextRequest) {
  const { orgId, plan, interval } = (await req.json()) as {
    orgId?: string; plan?: 'pro' | 'team'; interval?: 'month' | 'year'
  }
  if (!orgId || !plan || !interval) {
    return NextResponse.json({ error: 'orgId, plan, interval required' }, { status: 400 })
  }
  const priceId = PRICE_BY_PLAN_INTERVAL[`${plan}:${interval}`]
  if (!priceId) return NextResponse.json({ error: `no price configured for ${plan}/${interval}` }, { status: 400 })

  const [org] = await adminSql`SELECT id, slug, stripe_customer_id FROM orgs WHERE id = ${orgId}`
  if (!org) return NextResponse.json({ error: 'org not found' }, { status: 404 })

  const appUrl = process.env.APP_URL ?? 'http://localhost:14000'
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${appUrl}/billing`,
    client_reference_id: org.id,
    customer:    org.stripe_customer_id ?? undefined,
    allow_promotion_codes: true,
    metadata: { orgId: org.id, plan, interval },
  })

  return NextResponse.json({ url: session.url })
}
