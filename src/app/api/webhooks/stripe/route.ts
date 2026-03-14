import { NextRequest, NextResponse } from 'next/server';
import { constructWebhookEvent } from '@/lib/stripe';
import { query, queryOne, queryCount } from '@/lib/db';
import { resend, FROM_EMAIL } from '@/lib/resend';

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
    return NextResponse.json({ received: true });
  }

  const subscription = event.data.object as {
    id: string;
    customer: string;
    metadata: Record<string, string>;
    items: { data: Array<{ price: { unit_amount: number | null } }> };
  };

  const stripeAccountId = event.account ?? subscription.metadata.account_id;

  const org = await queryOne<{ id: string; plan: string }>(
    'SELECT id, plan FROM organizations WHERE stripe_account_id = $1 LIMIT 1',
    [stripeAccountId],
  );

  if (!org) {
    console.warn('No org found for Stripe account:', event.account);
    return NextResponse.json({ received: true });
  }

  if (org.plan === 'free') {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const count = await queryCount(
      'SELECT COUNT(*) FROM survey_responses WHERE org_id = $1 AND surveyed_at >= $2',
      [org.id, startOfMonth.toISOString()],
    );

    if (count >= 10) {
      return NextResponse.json({ received: true, skipped: 'free_tier_limit' });
    }
  }

  const { stripe } = await import('@/lib/stripe');
  const customer = await stripe.customers.retrieve(subscription.customer as string);
  if (customer.deleted) {
    return NextResponse.json({ received: true, skipped: 'customer_deleted' });
  }

  const customerEmail = customer.email;
  if (!customerEmail) {
    return NextResponse.json({ received: true, skipped: 'no_customer_email' });
  }

  const token = Buffer.from(
    JSON.stringify({
      orgId: org.id,
      customerId: subscription.customer,
      subscriptionId: subscription.id,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    }),
  ).toString('base64url');

  const surveyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/survey/${token}`;

  const mrrLost = Math.round(
    (subscription.items.data[0]?.price.unit_amount ?? 0) / 100,
  );

  await query(
    `INSERT INTO survey_responses (org_id, customer_email, customer_name, stripe_subscription_id, mrr_lost, token)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [org.id, customerEmail, customer.name ?? null, subscription.id, mrrLost, token],
  );

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
