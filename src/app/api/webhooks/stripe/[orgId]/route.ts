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

// One subscription line item, narrowed to just the fields MRR needs. Structural
// types (rather than Stripe's own) keep this route testable without building a
// full Stripe.Subscription fixture.
interface SubscriptionItemForMrr {
  quantity?: number | null;
  price: {
    unit_amount: number | null;
    recurring?: { interval: string; interval_count: number } | null;
  };
}

// How many months one billing interval is worth, i.e. the factor that converts
// a per-interval amount into a per-month amount. Weeks and days use calendar
// averages (52 weeks / 365 days a year) because there is no exact conversion.
const MONTHS_PER_INTERVAL: Record<string, number> = {
  day: 12 / 365,
  week: 12 / 52,
  month: 1,
  year: 12,
};

/**
 * Normalizes one subscription item to monthly cents: an annual plan must not be
 * recorded as 12x its true MRR, and a 5-seat plan must not be recorded as 1/5.
 *
 * Returns fractional cents on purpose — callers sum every item first and round
 * once at the end, so per-item rounding error cannot accumulate.
 *
 * Deliberately NOT exported: Next 14 type-checks the export shape of every
 * route.ts and rejects any export that is not an HTTP method or a known segment
 * config, so a named export here fails `next build`. To unit-test this directly
 * it has to move to its own module under src/lib.
 */
function monthlyCentsForItem(item: SubscriptionItemForMrr): number {
  // unit_amount is null for tiered and metered prices. The deleted-subscription
  // payload carries neither the tier that applied nor the usage that was billed,
  // so there is nothing to price from — count 0 rather than invent a number that
  // would land in a customer-visible revenue stat.
  const unitAmount = item.price.unit_amount ?? 0;
  if (unitAmount === 0) return 0;

  const recurring = item.price.recurring ?? null;

  let monthsPerInterval = recurring ? MONTHS_PER_INTERVAL[recurring.interval] : undefined;
  if (monthsPerInterval === undefined) {
    // An interval we do not recognize (a new Stripe value, or a payload missing
    // its recurring block) must not silently become 0 revenue — that would
    // under-report churn with no signal. Treat it as monthly, which is the most
    // common case and the least wrong default, and say so in the logs.
    console.warn(
      `Unrecognized billing interval ${JSON.stringify(recurring?.interval)} on subscription item — treating it as monthly for MRR.`,
    );
    monthsPerInterval = 1;
  }

  // interval_count is how many intervals one billing period spans (e.g. every 3
  // months). Guard 0/undefined, which would divide to Infinity or NaN.
  const intervalCount =
    recurring && recurring.interval_count > 0 ? recurring.interval_count : 1;

  const quantity = item.quantity ?? 1;

  return (unitAmount * quantity) / (monthsPerInterval * intervalCount);
}

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
    items: { data: SubscriptionItemForMrr[] };
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

  // Sum every line item, not just the first: a subscription with a base plan
  // plus an add-on lost both. survey_responses.mrr_lost is an integer dollar
  // column, so the arithmetic stays in cents and rounds exactly once, here.
  const mrrLostCents = subscription.items.data.reduce(
    (total, item) => total + monthlyCentsForItem(item),
    0,
  );
  const mrrLost = Math.round(mrrLostCents / 100);

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
