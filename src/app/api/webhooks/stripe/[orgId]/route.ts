import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { queryOne, queryCount, execute } from '@/lib/db';
import { decryptApiKey, signSurveyToken } from '@/lib/crypto';
import { sendSurveyEmail } from '@/lib/survey-email';
import { loadSurveyConfig } from '@/lib/survey-config';

// Stripe Customer Portal cancellation reasons → our survey categories.
// When the portal already asked, we record the answer directly and skip the
// email — asking the same question twice burns customer goodwill.
const PORTAL_FEEDBACK_TO_REASON: Record<string, string> = {
  too_expensive: 'Too expensive for my budget',
  missing_features: 'Missing a feature I need',
  switched_service: 'Switched to a competitor',
  unused: 'Stopped needing this type of tool',
  too_complex: 'Product was too difficult to use',
  customer_service: 'Had a bad support experience',
  low_quality: 'Quality was less than expected',
  other: 'Other',
};

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
    cancellation_details?: {
      comment: string | null;
      feedback: string | null;
      reason: string | null;
    } | null;
  };

  if (org.plan === 'free') {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Free tier caps surveys *sent* per month, so count by created_at. Counting
    // by surveyed_at (responses) let free orgs send unlimited surveys since most
    // customers never respond.
    const count = await queryCount(
      'SELECT COUNT(*) FROM survey_responses WHERE org_id = $1 AND created_at >= $2 AND NOT is_test',
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

  // Respect prior opt-outs (CAN-SPAM): never re-survey a customer who unsubscribed.
  const suppressed = await queryCount(
    'SELECT COUNT(*) FROM unsubscribes WHERE org_id = $1 AND customer_email = $2',
    [org.id, customerEmail],
  );
  if (suppressed > 0) {
    return NextResponse.json({ received: true, skipped: 'unsubscribed' });
  }

  const token = signSurveyToken({
    orgId: org.id,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  const surveyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/survey/${token}`;
  const optOutUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/survey/opt-out?token=${token}`;

  const mrrLost = Math.round(
    (subscription.items.data[0]?.price.unit_amount ?? 0) / 100,
  );

  // If the customer already answered Stripe's Customer Portal cancellation
  // survey, record that answer as a completed response and skip the email.
  const portalFeedback = subscription.cancellation_details?.feedback ?? null;
  const portalReason = portalFeedback
    ? PORTAL_FEEDBACK_TO_REASON[portalFeedback] ?? 'Other'
    : null;

  if (portalReason) {
    const inserted = await execute(
      `INSERT INTO survey_responses
         (org_id, customer_email, customer_name, stripe_subscription_id, mrr_lost, token, reason_category, open_text, surveyed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (stripe_subscription_id) DO NOTHING`,
      [
        org.id,
        customerEmail,
        customer.name ?? null,
        subscription.id,
        mrrLost,
        token,
        portalReason,
        subscription.cancellation_details?.comment ?? null,
        new Date().toISOString(),
      ],
    );

    if (inserted === 0) {
      return NextResponse.json({ received: true, skipped: 'duplicate_event' });
    }

    return NextResponse.json({ received: true, prefilled: 'portal_feedback' });
  }

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

  const config = await loadSurveyConfig(org.id);

  await sendSurveyEmail({
    to: customerEmail,
    customerName: customer.name ?? null,
    surveyUrl,
    optOutUrl,
    displayName: config.displayName,
  });

  return NextResponse.json({ received: true });
}
