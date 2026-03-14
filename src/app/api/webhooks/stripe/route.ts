import { NextRequest, NextResponse } from 'next/server';
import { constructWebhookEvent } from '@/lib/stripe';
import { getAdminClient } from '@/lib/supabase';
import { resend, FROM_EMAIL } from '@/lib/resend';

/**
 * POST /api/webhooks/stripe
 *
 * Stripe sends events here. We only care about:
 *   customer.subscription.deleted — trigger exit survey email.
 *
 * Security: signature verified via constructWebhookEvent (HMAC-SHA256).
 * Body must be read as raw buffer — do NOT use bodyParser.
 */
export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 });
  }

  let event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type !== 'customer.subscription.deleted') {
    // Acknowledge non-targeted events immediately
    return NextResponse.json({ received: true });
  }

  const subscription = event.data.object as {
    id: string;
    customer: string;
    metadata: Record<string, string>;
    items: { data: Array<{ price: { unit_amount: number | null } }> };
  };

  const db = getAdminClient();

  // Look up the org that owns this Stripe account
  const { data: org } = await db
    .from('organizations')
    .select('id, plan')
    .eq('stripe_account_id', event.account ?? subscription.metadata.account_id)
    .single();

  if (!org) {
    console.warn('No org found for Stripe account:', event.account);
    return NextResponse.json({ received: true });
  }

  // Free plan: cap at 10 cancellations/mo — count first
  if (org.plan === 'free') {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count } = await db
      .from('survey_responses')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', org.id)
      .gte('surveyed_at', startOfMonth.toISOString());

    if ((count ?? 0) >= 10) {
      return NextResponse.json({ received: true, skipped: 'free_tier_limit' });
    }
  }

  // Retrieve customer email from Stripe
  const { stripe } = await import('@/lib/stripe');
  const customer = await stripe.customers.retrieve(subscription.customer as string);
  if (customer.deleted) {
    return NextResponse.json({ received: true, skipped: 'customer_deleted' });
  }

  const customerEmail = customer.email;
  if (!customerEmail) {
    return NextResponse.json({ received: true, skipped: 'no_customer_email' });
  }

  // Create a signed survey token (JWT) — simplified: in production use jose
  const token = Buffer.from(
    JSON.stringify({
      orgId: org.id,
      customerId: subscription.customer,
      subscriptionId: subscription.id,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    }),
  ).toString('base64url');

  const surveyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/survey/${token}`;

  const mrrLost = Math.round(
    (subscription.items.data[0]?.price.unit_amount ?? 0) / 100,
  );

  // Store a pending survey record
  await db.from('survey_responses').insert({
    org_id: org.id,
    customer_email: customerEmail,
    customer_name: customer.name ?? null,
    stripe_subscription_id: subscription.id,
    mrr_lost: mrrLost,
    token,
  });

  // Send exit survey email via Resend
  await resend.emails.send({
    from: FROM_EMAIL,
    to: customerEmail,
    subject: 'Quick question before you go',
    text: `Hi${customer.name ? ` ${customer.name}` : ''},

We noticed you cancelled your subscription. We completely understand — no hard feelings.

One quick question: what was the main reason?

→ ${surveyUrl}

It takes two minutes and goes directly to the founder (not a support queue). Your answer genuinely shapes what gets built next.

Thanks,
The team

---
You received this because you had an active subscription. Unsubscribe from exit surveys: ${surveyUrl}?opt_out=1
`,
  });

  return NextResponse.json({ received: true });
}
