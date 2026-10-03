import { NextResponse } from 'next/server';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { execute, queryOne } from '@/lib/db';
import { getPolarWebhookSecret } from '@/lib/polar';
import { entitlementForStatus, planForProduct } from '@/lib/plan';
import { reportError } from '@/lib/report-error';

/**
 * Polar billing webhook — ChurnLens's own subscriptions.
 *
 * One platform-level endpoint, unlike /api/webhooks/stripe/[orgId], which is
 * per-org because it verifies each customer's own signing secret. Here there is
 * a single Polar organization (ours) and a single secret.
 *
 * The org is identified by external_customer_id, set to organizations.id when
 * the checkout session is created. Polar echoes it back on every subscription
 * event as data.customer.external_id, so no lookup table is needed and no
 * Polar-side id has to be resolved before the plan can be written.
 *
 * An org has one current subscription, organizations.polar_subscription_id.
 * That relies on a customer never holding two active subscriptions at once,
 * which is a Polar organization setting (allow_multiple_subscriptions, to be
 * kept off), not a guarantee: the SDK's checkout calls can refuse a customer
 * who already has one (AlreadyActiveSubscriptionError), and nothing here can
 * check the setting is actually off. If two are ever active at once, the org
 * follows whichever was granted last and drops to free when that one ends,
 * until the other's next event; tracking each subscription separately is what
 * it would take to do better.
 */

/** Subscription events carry the whole subscription; the rest we acknowledge and ignore. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.active',
  'subscription.updated',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.past_due',
  'subscription.revoked',
  'subscription.paused',
  'subscription.resumed',
  'subscription.cycled',
]);

export async function POST(req: Request) {
  // Signature verification needs the exact bytes Polar signed, so the body must
  // be read raw — parsing it first would reserialize and break the signature.
  const rawBody = Buffer.from(await req.arrayBuffer());

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let event;
  try {
    event = validateEvent(rawBody, headers, getPolarWebhookSecret());
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      // Logged, never reported: anyone can POST a bad signature here.
      console.error('Polar webhook signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }
    // A missing secret is a misconfiguration, not a bad request: 500 so it is
    // visible and so Polar retries once the environment is fixed. Reported:
    // until it is fixed no subscription change reaches any org's plan.
    reportError('webhook.polar', err, { step: 'validate' });
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  if (!SUBSCRIPTION_EVENTS.has(event.type)) {
    return NextResponse.json({ received: true, skipped: 'unhandled_event' });
  }

  const subscription = event.data as {
    id: string;
    status: string;
    productId: string;
    customerId: string;
    modifiedAt: Date | null;
    createdAt: Date;
    customer: { id: string; externalId?: string | null };
  };

  const orgId = subscription.customer?.externalId;
  if (!orgId) {
    // A subscription created outside our checkout flow (dashboard, import) has
    // no external id and cannot be attributed. Acknowledge so Polar stops
    // retrying, but say so loudly — it means someone was charged and got nothing.
    reportError(
      'webhook.polar',
      new Error(`Polar ${event.type} has no customer external_id — cannot map it to an organization.`),
      { subscriptionId: subscription.id, step: 'no_external_id' },
    );
    return NextResponse.json({ received: true, skipped: 'no_external_id' });
  }

  const decision = entitlementForStatus(subscription.status);
  if (decision === 'ignore') {
    return NextResponse.json({ received: true, skipped: `status_${subscription.status}` });
  }

  let plan: string;
  if (decision === 'revoke') {
    plan = 'free';
  } else {
    const granted = planForProduct(subscription.productId);
    if (!granted) {
      // Refuse to guess a tier. Granting the wrong one either gives away the
      // more expensive plan or withholds what was paid for; both are worse than
      // leaving the plan untouched and alerting.
      reportError(
        'webhook.polar',
        new Error(
          `Polar ${event.type}: product maps to no known plan — check POLAR_PRODUCT_STARTER / ` +
            'POLAR_PRODUCT_GROWTH. The org was left unchanged.',
        ),
        { orgId, productId: subscription.productId, subscriptionId: subscription.id, step: 'unknown_product' },
      );
      return NextResponse.json({ received: true, skipped: 'unknown_product' });
    }
    plan = granted;
  }

  // Webhook delivery is not ordered. A delayed `subscription.updated` can land
  // after the `subscription.revoked` that superseded it, and applying it would
  // hand back a paid plan the customer no longer has. The watermark makes the
  // write conditional on this event being newer than the last one applied.
  const eventAt = subscription.modifiedAt ?? subscription.createdAt;

  // A grant always makes its subscription the org's current one — that is how
  // an org moves to a new subscription. A revoke only counts for the current
  // one: once an org has moved from A to B, A ending (or a late event about A
  // having ended) must not downgrade an org that is paying through B. With no
  // subscription recorded yet the revoke still applies, because it is what sets
  // the watermark that stops that subscription's delayed grant from landing
  // after it.
  //
  // A skipped revoke writes nothing, watermark included: the watermark is per
  // org, and advancing it for A would throw away B's own delayed events.
  //
  // Both conditions sit in this one UPDATE rather than a read followed by a
  // write. A grant for B committing between a read and a write would otherwise
  // be overwritten by A's revoke; here Postgres re-evaluates the WHERE against
  // the row version it waited for, so the revoke sees B and matches nothing.
  const updated = await execute(
    `UPDATE organizations
     SET plan = $1,
         polar_customer_id = $2,
         polar_subscription_id = $3,
         polar_synced_at = $4
     WHERE id = $5
       AND (polar_synced_at IS NULL OR polar_synced_at < $4)
       AND ($6::text = 'grant'
            OR polar_subscription_id IS NULL
            OR polar_subscription_id = $3)`,
    [plan, subscription.customerId, subscription.id, eventAt, orgId, decision],
  );

  if (updated === 0 && decision === 'revoke') {
    // Only names the skip — the UPDATE above has already decided it. A delivery
    // landing between the two statements can at worst mislabel this response,
    // never change what was written.
    const org = await queryOne<{ polar_subscription_id: string | null }>(
      `SELECT polar_subscription_id FROM organizations WHERE id = $1`,
      [orgId],
    );
    if (org?.polar_subscription_id && org.polar_subscription_id !== subscription.id) {
      // Expected after a move to a new subscription, so not a warning.
      console.log(
        `Polar ${event.type}: subscription ${subscription.id} is not org ${orgId}'s current ` +
          `subscription (${org.polar_subscription_id}) — revoke ignored.`,
      );
      return NextResponse.json({ received: true, skipped: 'not_current_subscription' });
    }
  }

  if (updated === 0) {
    // Either the org is gone or this event is stale. Both are acknowledged —
    // retrying will not change the outcome.
    console.warn(
      `Polar ${event.type} for org ${orgId} applied to no row (stale event or unknown org).`,
    );
    return NextResponse.json({ received: true, skipped: 'stale_or_unknown_org' });
  }

  console.log(`Polar ${event.type}: org ${orgId} → plan ${plan} (status ${subscription.status})`);
  return NextResponse.json({ received: true, orgId, plan });
}
