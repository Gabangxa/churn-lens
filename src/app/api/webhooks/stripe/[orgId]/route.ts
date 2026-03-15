import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { queryOne, queryCount, execute } from '@/lib/db';
import { decryptApiKey, signSurveyToken } from '@/lib/crypto';
import { resend, FROM_EMAIL } from '@/lib/resend';

export async function POST(
  req: NextRequest,
  { params }: { params: { orgId: string } },
) {
  const { orgId } = params;

  const rawBody = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 });
  }

  // Look up org and its per-org webhook signing secret before verifying.
  const org = await queryOne<{
    id: string;
    plan: string;
    stripe_api_key_enc: string | null;
    stripe_webhook_secret_enc: string | null;
  }>(
    `SELECT id, plan, stripe_api_key_enc, stripe_webhook_secret_enc
     FROM organizations WHERE id = $1`,
    [orgId],
  );

  if (!org || !org.stripe_webhook_secret_enc) {
    return NextResponse.json({ error: 'Unknown organization' }, { status: 404 });
  }

  const webhookSecret = decryptApiKey(org.stripe_webhook_secret_enc);

  let event: Stripe.Event;
  try {
    // Verify using the org's own webhook signing secret (not the platform-level secret).
    event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error(`Webhook signature verification failed for org ${orgId}:`, err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type !== 'customer.subscription.deleted') {
    return NextResponse.json({ received: true });
  }

  const subscription = event.data.object as {
    id: string;
    customer: string;
    items: { data: Array<{ price: { unit_amount: number | null } }> };
  };

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

  if (!org.stripe_api_key_enc) {
    console.warn(`Org ${orgId} has no Stripe API key stored — cannot retrieve customer.`);
    return NextResponse.json({ received: true, skipped: 'no_api_key' });
  }

  const apiKey = decryptApiKey(org.stripe_api_key_enc);
  const stripeClient = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });

  const customer = await stripeClient.customers.retrieve(subscription.customer);
  if (customer.deleted) {
    return NextResponse.json({ received: true, skipped: 'customer_deleted' });
  }

  const customerEmail = customer.email;
  if (!customerEmail) {
    return NextResponse.json({ received: true, skipped: 'no_customer_email' });
  }

  const token = signSurveyToken({
    orgId: org.id,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  const surveyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/survey/${token}`;

  const mrrLost = Math.round(
    (subscription.items.data[0]?.price.unit_amount ?? 0) / 100,
  );

  // Idempotency guard: skip if this subscription has already been processed.
  const inserted = await execute(
    `INSERT INTO survey_responses (org_id, customer_email, customer_name, stripe_subscription_id, mrr_lost, token)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_subscription_id) DO NOTHING`,
    [org.id, customerEmail, customer.name ?? null, subscription.id, mrrLost, token],
  );

  if (inserted === 0) {
    return NextResponse.json({ received: true, skipped: 'duplicate_event' });
  }

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
