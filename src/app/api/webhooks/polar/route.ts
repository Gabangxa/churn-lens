import { NextResponse } from 'next/server';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { SDKValidationError } from '@polar-sh/sdk/models/errors/sdkvalidationerror.js';
import { withTransaction } from '@/lib/db';
import { getPolarWebhookSecret, isPolarWebhookConfigured } from '@/lib/polar';
import { entitlementForStatus, planForProduct } from '@/lib/plan';
import { lockOrganization, recomputeOrgPlan } from '@/lib/org-plan';
import { reportError } from '@/lib/report-error';
import { withErrorReporting } from '@/lib/with-error-reporting';

/**
 * Polar billing webhook — ChurnLens's own subscriptions.
 *
 * One platform-level endpoint, unlike /api/webhooks/stripe/[orgId], which is
 * per-org because it verifies each customer's own signing secret. Here there is
 * a single Polar organization (ours) and a single secret.
 *
 * The org is identified by external_customer_id, set to organizations.id when
 * the checkout session is created. Polar echoes it back on every subscription
 * event as data.customer.external_id, so no lookup table is needed.
 *
 * Each subscription's latest state is kept in polar_subscriptions, ordered by
 * that subscription's own modified_at, and the org's plan is recomputed from
 * all of its subscriptions plus any admin comp (src/lib/org-plan.ts). Webhook
 * delivery is not ordered, and nothing here depends on it being: a stale event
 * loses to the newer one already recorded for the same subscription, and
 * events for different subscriptions no longer compete for one watermark. An
 * org holding two subscriptions at once (Polar's allow_multiple_subscriptions
 * is meant to be off, but nothing here can check) gets the higher tier, and
 * falls back to the other when that one ends.
 */

/**
 * Polar's timestamps carry microseconds. Kept as the string Polar sent and cast
 * by Postgres, never through a JS Date, which would truncate to milliseconds
 * and make two changes within one millisecond look like the same change.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

/** organizations.id. Anything else must not reach a uuid column: Postgres throws 22P02. */
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the plan needs from a subscription event, read from Polar's wire format. */
interface SubscriptionFacts {
  id: string;
  status: string;
  productId: string;
  customerId: string | null;
  /** modified_at, else created_at for a subscription never modified. */
  changedAt: string;
  externalId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** null when a field the plan depends on is missing or malformed. */
function readSubscription(data: Record<string, unknown>): SubscriptionFacts | null {
  const { id, status, product_id, customer_id, modified_at, created_at, customer } = data;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof status !== 'string' || status === '') return null;
  if (typeof product_id !== 'string' || product_id === '') return null;

  const changedAt = modified_at ?? created_at;
  if (typeof changedAt !== 'string' || !ISO_TIMESTAMP.test(changedAt)) return null;

  const externalId = isRecord(customer) ? customer.external_id : null;
  return {
    id,
    status,
    productId: product_id,
    customerId: typeof customer_id === 'string' && customer_id !== '' ? customer_id : null,
    changedAt,
    externalId: typeof externalId === 'string' && externalId !== '' ? externalId : null,
  };
}

type Applied = { kind: 'applied'; plan: string } | { kind: 'stale' } | { kind: 'unknown_org' };

// Logged at most once per process: a missing secret is a property of the
// deployment, not of a request, and this URL is public.
let warnedNotConfigured = false;

async function handlePolarWebhook(req: Request) {
  // Billing is not wired in every environment (README, "Deploying
  // fix/launch-hardening", step 2), and without a secret there is nothing to
  // verify a delivery against. 503, like checkout without a product: retrying
  // will not help until the environment is configured. Never reported: anyone
  // can POST here, and each POST would otherwise be an alert.
  if (!isPolarWebhookConfigured()) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn('Polar webhook received but POLAR_WEBHOOK_SECRET is not set — answering 503 until it is.');
    }
    return NextResponse.json({ error: 'Polar webhooks not configured' }, { status: 503 });
  }

  // Signature verification needs the exact bytes Polar signed, so the body must
  // be read raw — parsing it first would reserialize and break the signature.
  // A sender that hangs up mid-body makes the read throw ('aborted'): nothing
  // of ours failed and there is nothing to verify, so it is a 400 here rather
  // than an escaped throw that withErrorReporting would alert on.
  let rawBody: Buffer;
  try {
    rawBody = Buffer.from(await req.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'Could not read the request body' }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // validateEvent verifies the signature, then schema-parses the payload into
  // one of the event types its parser dispatches. Only the verification is
  // relied on. The fields below are read from the verified body itself: some
  // event types Polar does send fail that parse with SDKValidationError, and
  // the SDK's Dates drop the microseconds the ordering below needs. In
  // @polar-sh/sdk 0.49.0, subscription.cycled and .migrated have no webhook
  // payload model at all (every renewal is a .cycled); .paused and .resumed do
  // have models (WebhookSubscriptionPausedPayload / ...ResumedPayload) but
  // validateEvent's parser has no case for them, so they fail the same way.
  let sdkParsed = true;
  try {
    validateEvent(rawBody, headers, getPolarWebhookSecret());
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      // Logged, never reported: anyone can POST a bad signature here.
      console.error('Polar webhook signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }
    if (err instanceof SDKValidationError) {
      // Only ever thrown after the signature checked out (parseEvent runs on
      // the verified payload), so the body is Polar's. Not a failure: the SDK
      // simply has no model for this event.
      sdkParsed = false;
    } else {
      // Not a bad signature (that is the 403 above) and the secret is set, so
      // nothing a stranger can cause: a body that checked out against our
      // secret but is not JSON, or the SDK failing in a way it never has.
      // 500 so Polar retries, and reported, since no event lands until it is
      // understood.
      reportError('webhook.polar', err, { step: 'validate' });
      return NextResponse.json({ error: 'Could not verify the event' }, { status: 500 });
    }
  }

  // Cannot throw: verification has already parsed these same bytes as JSON.
  const payload: unknown = JSON.parse(rawBody.toString('utf8'));
  const type = isRecord(payload) && typeof payload.type === 'string' ? payload.type : null;

  if (!type || !type.startsWith('subscription.')) {
    if (sdkParsed) {
      return NextResponse.json({ received: true, skipped: 'unhandled_event' });
    }
    // Expected as Polar adds event types; nothing here depends on them.
    console.log(`Polar webhook: ${type ?? 'untyped'} event is not one the SDK models — acknowledged, ignored.`);
    return NextResponse.json({ received: true, skipped: 'unparsed_event' });
  }

  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
  const subscription = readSubscription(data);
  if (!subscription) {
    // Polar changed the shape of a subscription payload. Retrying will not
    // change it, so acknowledge — loudly, since plan changes stop landing.
    reportError(
      'webhook.polar',
      new Error(`Polar ${type}: subscription payload is missing a field the plan needs (id, status, product_id, modified_at).`),
      { subscriptionId: typeof data.id === 'string' ? data.id : null, step: 'malformed_event' },
    );
    return NextResponse.json({ received: true, skipped: 'malformed_event' });
  }

  if (!subscription.externalId) {
    // A subscription created outside our checkout flow (dashboard, import) has
    // no external id and cannot be attributed. Acknowledge so Polar stops
    // retrying, but say so loudly — it means someone was charged and got nothing.
    reportError(
      'webhook.polar',
      new Error(`Polar ${type} has no customer external_id — cannot map it to an organization.`),
      { subscriptionId: subscription.id, step: 'no_external_id' },
    );
    return NextResponse.json({ received: true, skipped: 'no_external_id' });
  }

  if (!ORG_ID.test(subscription.externalId)) {
    // Same story, but the external id was set by someone else — and it may be
    // an email, so it is never logged or reported, only the subscription id.
    reportError(
      'webhook.polar',
      new Error(`Polar ${type}: customer external_id is not an organization id — cannot map it to an organization.`),
      { subscriptionId: subscription.id, step: 'bad_external_id' },
    );
    return NextResponse.json({ received: true, skipped: 'bad_external_id' });
  }
  const orgId = subscription.externalId;

  const decision = entitlementForStatus(subscription.status);
  if (decision === 'ignore') {
    // incomplete: never paid, so it neither grants nor ends anything.
    return NextResponse.json({ received: true, skipped: `status_${subscription.status}` });
  }

  let result: Applied;
  try {
    result = await withTransaction(async (client): Promise<Applied> => {
      // Serialises every delivery for this org (and the admin comp route), so
      // the recompute below always sees the other writers' committed rows.
      if (!(await lockOrganization(client, orgId))) return { kind: 'unknown_org' };

      // Lands only when newer than what is recorded for this same subscription.
      // A delayed event, or a redelivery, matches nothing and changes nothing.
      const upsert = await client.query(
        `INSERT INTO polar_subscriptions (id, org_id, status, product_id, modified_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (id) DO UPDATE
           SET status = EXCLUDED.status,
               product_id = EXCLUDED.product_id,
               modified_at = EXCLUDED.modified_at
           WHERE polar_subscriptions.modified_at < EXCLUDED.modified_at`,
        [subscription.id, orgId, subscription.status, subscription.productId, subscription.changedAt],
      );
      if (upsert.rowCount === 0) return { kind: 'stale' };

      // polar_synced_at no longer decides anything. It is kept at the newest
      // change applied so a rollback to the watermark code starts from a
      // watermark that is not stale.
      await client.query(
        `UPDATE organizations
         SET polar_customer_id = COALESCE($2, polar_customer_id),
             polar_synced_at = GREATEST(polar_synced_at, $3::timestamptz)
         WHERE id = $1`,
        [orgId, subscription.customerId, subscription.changedAt],
      );

      const { plan } = await recomputeOrgPlan(client, orgId);
      return { kind: 'applied', plan };
    });
  } catch (err) {
    // The database, not the event: 500 so Polar retries it.
    reportError('webhook.polar', err, { orgId, subscriptionId: subscription.id, step: 'apply' });
    return NextResponse.json({ error: 'Could not apply the event' }, { status: 500 });
  }

  if (result.kind === 'unknown_org') {
    // A purged org, or one from another environment sharing this Polar org.
    // Retrying will not change it.
    console.warn(`Polar ${type} for org ${orgId}: no such organization — acknowledged.`);
    return NextResponse.json({ received: true, skipped: 'unknown_org' });
  }
  if (result.kind === 'stale') {
    return NextResponse.json({ received: true, skipped: 'stale_event' });
  }

  if (decision === 'grant' && !planForProduct(subscription.productId)) {
    // Recorded all the same, granting nothing: guessing a tier either gives
    // away the more expensive plan or withholds what was paid for. Once the
    // mapping is fixed, the org's next event grants it. Reported only once the
    // event has landed: a redelivery, or an org that is not in this database
    // (another environment's, whose product ids are not ours to map), is noise.
    reportError(
      'webhook.polar',
      new Error(
        `Polar ${type}: product maps to no known plan — check POLAR_PRODUCT_STARTER / ` +
          'POLAR_PRODUCT_GROWTH. The subscription grants nothing until it does.',
      ),
      { orgId, productId: subscription.productId, subscriptionId: subscription.id, step: 'unknown_product' },
    );
  }

  console.log(
    `Polar ${type}: subscription ${subscription.id} is ${subscription.status}; org ${orgId} → plan ${result.plan}`,
  );
  return NextResponse.json({ received: true, orgId, plan: result.plan });
}

export const POST = withErrorReporting('webhook.polar', handlePolarWebhook);
