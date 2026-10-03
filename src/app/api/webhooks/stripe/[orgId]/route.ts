import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { queryOne, queryCount, execute } from '@/lib/db';
import { decryptApiKey, signSurveyToken } from '@/lib/crypto';
import { sendSurveyEmail, LegalFooterUnfilledError } from '@/lib/survey-email';
import { legalFooterReady } from '@/lib/legal';
import { loadSurveyPresentation } from '@/lib/survey-config';
import { cacheStripeBusinessName, fetchStripeBusinessName } from '@/lib/stripe-business-name';
import { FREE_TIER_MONTHLY_SURVEYS } from '@/lib/plan';
import { countFreeTierSurveys } from '@/lib/survey-status';
import { reportError } from '@/lib/report-error';

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

// cancellation_details.reason values meaning Stripe ended the subscription
// itself, not the customer: dunning gave up on a failed payment, or a charge
// was disputed. An exit survey asks "why did you leave?", which is the wrong
// question for someone whose card bounced — they never chose to. The only other
// value, 'cancellation_requested', is a deliberate cancel and is surveyed.
const INVOLUNTARY_CANCELLATION_REASONS = new Set(['payment_failed', 'payment_disputed']);

// How many times we let Stripe retry a survey email before giving up. A
// permanently-failing address (hard bounce, blocked domain) would otherwise
// make this route 500 on every retry for the whole of Stripe's retry window.
const MAX_SURVEY_EMAIL_ATTEMPTS = 5;

// How long a claimed send is treated as still in flight. Stripe delivers
// at-least-once, so two deliveries of the same cancellation can overlap; the
// claim UPDATE below refuses the second one while the first is inside this
// window, which is what stops the customer getting two identical emails.
//
// The floor is the platform request timeout (10s on Vercel), past which an
// in-flight send is dead and its row is genuinely stranded. The ceiling is
// Stripe's first retry interval (~1h), so a real retry is never blocked.
const SURVEY_EMAIL_CLAIM_COOLDOWN_SECONDS = 120;

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
 * Whether a Stripe API failure means the stored key itself is unusable, as
 * opposed to Stripe being briefly unavailable. The SDK raises these by HTTP
 * status: 401 (revoked, rolled, or mistyped key) and 403 (a restricted key
 * missing a permission it needs). Neither changes until the founder acts, so
 * retrying them is pointless; everything else (429, 5xx, network) is transient.
 * Same classification as /api/onboarding/connect uses to blame the key.
 */
function isStripeKeyRejected(
  err: unknown,
): err is Stripe.errors.StripeAuthenticationError | Stripe.errors.StripePermissionError {
  return (
    err instanceof Stripe.errors.StripeAuthenticationError ||
    err instanceof Stripe.errors.StripePermissionError
  );
}

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
    deletion_requested_at: string | null;
    // node-postgres parses timestamptz into a Date.
    stripe_key_invalid_at: Date | null;
  }>(
    `SELECT id, plan, stripe_api_key_enc, stripe_webhook_secret_enc, deletion_requested_at,
            stripe_key_invalid_at
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
    // Logged, never reported: anyone who knows an org's webhook URL can send
    // a bad signature, so an alert here would be an alert anyone can trigger.
    console.error(`Webhook signature verification failed for org ${orgId}:`, err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // CAN-SPAM footer not fillable yet: refuse before anything is recorded, not
  // just before the email is sent. Checked here — before the customer is even
  // retrieved from Stripe, and before either survey_responses write path below
  // (the portal-feedback insert and the email-claim insert both write real,
  // permanent rows) — so a not-yet-configured deploy burns no claim attempt
  // and records nothing at all. 200 so Stripe does not retry-storm the event.
  //
  // Reported, not just logged: while this holds every cancellation for every
  // org is dropped, and only the operator can fix it. Below the signature
  // check, not above it: the webhook URL is just the org id, so above it
  // anyone could raise this alert at will. The message carries no ids, so
  // every org's block is one fingerprint: at most one alert email an hour.
  if (!legalFooterReady()) {
    reportError(
      'webhook.stripe',
      new Error(
        'Survey email blocked: src/lib/legal.ts still has unfilled placeholders required for ' +
          'the CAN-SPAM footer (LEGAL.entity / LEGAL.postalAddress). Fill them in before this ' +
          'deploys real traffic.',
      ),
      { orgId: org.id, step: 'legal_footer' },
    );
    return NextResponse.json({ received: true, skipped: 'legal_footer_unfilled' });
  }

  // Deletion requested: stop collecting new PII for an account on its way out.
  // Checked before the customer is even retrieved from Stripe — the whole
  // point is that no further personal data is fetched or stored once erasure
  // has been requested, not just that no email goes out. Sits below signature
  // verification so an unauthenticated caller holding the URL cannot probe
  // whether an org is being deleted.
  if (org.deletion_requested_at) {
    return NextResponse.json({ received: true, skipped: 'deletion_pending' });
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

  // Involuntary churn is skipped before anything else happens to the event:
  // before the customer's email and name are retrieved from Stripe (data
  // minimisation — there is no reason to pull personal data for someone we
  // will not contact) and before either survey_responses write path, so not
  // even a portal-prefilled row is recorded. 200 so Stripe does not retry.
  // A payload with no cancellation_details (accounts pinned to an old API
  // version) cannot be shown to be involuntary and is surveyed as before.
  const cancellationReason = subscription.cancellation_details?.reason ?? null;
  if (cancellationReason !== null && INVOLUNTARY_CANCELLATION_REASONS.has(cancellationReason)) {
    return NextResponse.json({ received: true, skipped: 'involuntary_churn' });
  }

  if (org.plan === 'free') {
    // The cap limits how many cancellations get a survey, so it gates only a
    // subscription we have never recorded. One that already has a row was
    // counted when that row was written: Stripe redelivering it — a retry of a
    // send that failed, or a plain duplicate — must reach the idempotency and
    // stranded-send handling below exactly as it would under the cap. Refusing
    // it here (as this once did) turned the 10th survey's failed send into a
    // survey that was never retried, reported as 'free_tier_limit'.
    //
    // Scoped to this org so another tenant's row can never move this org past
    // its cap. Checked from the database alone, before the customer is fetched
    // from Stripe, so a refused cancellation still pulls no personal data.
    const alreadyRecorded = await queryOne<{ recorded: number }>(
      `SELECT 1 AS recorded FROM survey_responses
       WHERE stripe_subscription_id = $1 AND org_id = $2`,
      [subscription.id, org.id],
    );

    if (!alreadyRecorded) {
      // Shared with the dashboard's status line, so the founder sees the cap
      // exactly when this starts enforcing it.
      const count = await countFreeTierSurveys(org.id);

      if (count >= FREE_TIER_MONTHLY_SURVEYS) {
        return NextResponse.json({ received: true, skipped: 'free_tier_limit' });
      }
    }
  }

  if (!org.stripe_api_key_enc) {
    console.warn(`Org ${orgId} has no Stripe API key stored — cannot retrieve customer.`);
    return NextResponse.json({ received: true, skipped: 'no_api_key' });
  }

  const apiKey = decryptApiKey(org.stripe_api_key_enc);
  const stripeClient = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });

  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripeClient.customers.retrieve(subscription.customer);
  } catch (err) {
    if (isStripeKeyRejected(err)) {
      // The key is revoked, rolled, or no longer allowed to read customers.
      // Every retry would fail identically until the founder reconnects, so
      // answer 200 to stop Stripe's days-long retry schedule, and flag the org
      // so the dashboard tells the founder why surveys stopped.
      //
      // The flag is keyed to the exact ciphertext this request used. If the
      // founder reconnected while this call was in flight, the row now holds a
      // different key that nothing has rejected, and the UPDATE matches no
      // row. IS NULL keeps the time of the FIRST rejection. Not wrapped: if
      // this write fails the error 500s, and Stripe's retry will both meet the
      // same rejection and try the flag again — the right outcome either way.
      await execute(
        `UPDATE organizations SET stripe_key_invalid_at = now()
         WHERE id = $1 AND stripe_api_key_enc = $2 AND stripe_key_invalid_at IS NULL`,
        [org.id, org.stripe_api_key_enc],
      );
      //
      // A warning, not an operator alert: the founder revoked or restricted
      // their own key, only they can fix it, and the flag above puts it on
      // their dashboard with a reconnect link. Alerting would page the
      // operator once per affected org per hour about something they cannot
      // act on, out of the same hourly budget as real failures.
      console.warn(
        `Stripe rejected the stored API key for org ${org.id} ` +
          `(${err.type}, HTTP ${err.statusCode ?? 'unknown'}) — skipping subscription ` +
          `${subscription.id}; surveys are stopped until the founder reconnects Stripe.`,
      );
      return NextResponse.json({ received: true, skipped: 'stripe_key_invalid' });
    }

    // Rate limit, Stripe 5xx, network failure: transient. Nothing has been
    // recorded yet, so a 5xx lets Stripe's retry start this event cleanly.
    // Reported all the same: Stripe's retries are what recover a blip, but a
    // lookup that keeps failing (egress broken, Stripe down) is every survey
    // on the platform stalled, and the fingerprint throttle keeps a blip to
    // one email.
    reportError('webhook.stripe', err, {
      orgId: org.id,
      subscriptionId: subscription.id,
      step: 'customer_lookup',
    });
    return NextResponse.json({ error: 'Stripe customer lookup failed' }, { status: 502 });
  }

  if (org.stripe_key_invalid_at !== null) {
    // The key was flagged by an earlier delivery and has just worked — e.g.
    // the founder restored its permissions in Stripe without reconnecting
    // here. Same ciphertext condition as the flag, so a success can only
    // clear the flag about the key that succeeded. Best-effort: a status-line
    // write must not decide whether this customer is surveyed.
    try {
      await execute(
        `UPDATE organizations SET stripe_key_invalid_at = NULL
         WHERE id = $1 AND stripe_api_key_enc = $2`,
        [org.id, org.stripe_api_key_enc],
      );
    } catch (err) {
      // The founder's dashboard keeps telling them to reconnect a key that
      // works until a later delivery clears it.
      reportError('webhook.stripe', err, { orgId: org.id, step: 'clear_key_invalid' });
    }
  }

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
    // survey_email_sent_at stays NULL here, which is the truth: this branch
    // deliberately sends no email. It cannot be picked up by the stranded-send
    // retry path below because that path also requires surveyed_at IS NULL, and
    // every row this branch writes sets surveyed_at. Keeping sent_at honest (as
    // opposed to back-dating it to suppress the retry) means delivery stats can
    // still tell "we never emailed this customer" from "the email went out".
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
  //
  // The insert claims the send in the same statement — survey_email_attempts
  // starts at 1 and survey_email_last_attempt_at at now(), BEFORE the email
  // goes out. Counting the attempt afterwards would miss the send that never
  // returns (Resend stalls, the platform kills the request mid-flight): the
  // counter would stay at 0 and the attempt cap would never engage, while a
  // concurrent delivery would see an unclaimed row and mail the customer again.
  const inserted = await execute(
    `INSERT INTO survey_responses
       (org_id, customer_email, customer_name, stripe_subscription_id, mrr_lost, token,
        survey_email_attempts, survey_email_last_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, now())
     ON CONFLICT (stripe_subscription_id) DO NOTHING`,
    [org.id, customerEmail, customer.name ?? null, subscription.id, mrrLost, token],
  );

  // The token that will actually be emailed. On the first insert it is the one
  // we just signed and stored; on a retry it must be the token already on the
  // row (see below).
  let emailToken = token;

  if (inserted === 0) {
    // The row already exists. That is usually a genuine duplicate delivery — but
    // it is also exactly what a *failed* send looks like on Stripe's retry.
    //
    // Claim the send with a single conditional UPDATE rather than reading the
    // row and then deciding. Every condition that makes a row re-sendable is in
    // the WHERE clause, and the same statement consumes the attempt, so under
    // concurrent deliveries Postgres serializes the two writers on the row lock
    // and re-checks the predicate against the winner's committed version: only
    // one delivery can ever come away with a token, and therefore only one email
    // is sent. A read-then-act would let both deliveries observe the pre-send
    // state and both send.
    //
    // Reuse the token on the row, never a freshly signed one: survey_responses.
    // token is UNIQUE and the survey page resolves the row *by* token, so a new
    // token would email a link that matches no row at all.
    const claimed = await queryOne<{ token: string }>(
      `UPDATE survey_responses
       SET survey_email_attempts = survey_email_attempts + 1,
           survey_email_last_attempt_at = now()
       WHERE stripe_subscription_id = $1
         AND org_id = $2
         AND surveyed_at IS NULL
         AND survey_email_sent_at IS NULL
         AND NOT is_test
         AND token IS NOT NULL
         AND survey_email_attempts < $3
         AND (survey_email_last_attempt_at IS NULL
              OR survey_email_last_attempt_at < now() - make_interval(secs => $4))
       RETURNING token`,
      [
        subscription.id,
        org.id,
        MAX_SURVEY_EMAIL_ATTEMPTS,
        SURVEY_EMAIL_CLAIM_COOLDOWN_SECONDS,
      ],
    );

    if (!claimed) {
      // We did not win the claim. Read the row to tell Stripe *why*, so an
      // address that will never work stops being retried. This read decides
      // only the response body — never whether to send — so it cannot race.
      const existing = await queryOne<{
        surveyed_at: string | null;
        survey_email_sent_at: string | null;
        survey_email_attempts: number;
        is_test: boolean;
      }>(
        `SELECT surveyed_at, survey_email_sent_at, survey_email_attempts, is_test
         FROM survey_responses
         WHERE stripe_subscription_id = $1 AND org_id = $2`,
        [subscription.id, org.id],
      );

      if (
        existing &&
        existing.surveyed_at === null &&
        existing.survey_email_sent_at === null &&
        !existing.is_test &&
        existing.survey_email_attempts >= MAX_SURVEY_EMAIL_ATTEMPTS
      ) {
        // Return 200 so Stripe stops retrying — the address is not going to
        // start working. The row stays with survey_email_sent_at NULL, which is
        // how an operator finds it.
        // The recipient address is deliberately NOT logged. It is a tenant's
        // customer's personal information and this log ships to the platform's
        // aggregator; the subscription id identifies the row for an operator
        // without putting a data subject's email in third-party retention.
        // The ids ride in meta, not the message, so every exhausted send
        // groups under one fingerprint instead of alerting once per
        // subscription.
        reportError(
          'webhook.stripe.send',
          new Error(`Survey email exhausted ${MAX_SURVEY_EMAIL_ATTEMPTS} send attempts — giving up.`),
          { orgId: org.id, subscriptionId: subscription.id, step: 'exhausted' },
        );
        return NextResponse.json({ received: true, skipped: 'email_send_exhausted' });
      }

      // Everything else — already answered, already emailed, a test row, no
      // token, another org's subscription, or a sibling delivery holding the
      // claim right now — is a plain duplicate.
      return NextResponse.json({ received: true, skipped: 'duplicate_event' });
    }

    emailToken = claimed.token;
  }

  const surveyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/survey/${emailToken}`;
  const optOutUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/survey/opt-out?token=${emailToken}`;

  // Which business the email says is asking. Looked up here, after the claim,
  // so only a cancellation we are actually about to email costs a Stripe call.
  let presentation = await loadSurveyPresentation(org.id);
  if (presentation.businessName === null) {
    // No display name configured and no Stripe name cached yet: try the
    // account once more (it fails harmlessly for keys without the account
    // permission). The name is used only once it is cached against the key
    // that read it: a false means the founder replaced that key mid-lookup,
    // and the name may be another business's.
    const stripeName = await fetchStripeBusinessName(stripeClient, org.id);
    if (
      stripeName !== null &&
      (await cacheStripeBusinessName(org.id, org.stripe_api_key_enc, stripeName))
    ) {
      presentation = { ...presentation, businessName: stripeName };
    }
  }

  try {
    await sendSurveyEmail({
      to: customerEmail,
      customerName: customer.name ?? null,
      surveyUrl,
      optOutUrl,
      displayName: presentation.businessName,
    });
  } catch (err) {
    if (err instanceof LegalFooterUnfilledError) {
      // Belt-and-braces only: legalFooterReady() is already checked above,
      // before either survey_responses write path, so sendSurveyEmail should
      // never actually reach this in practice — there is no window between
      // that check and this call where the answer could change. If it somehow
      // fires anyway, the attempt was already claimed by the INSERT above (same
      // as any other send failure below), so treat it the same way: log
      // clearly which file to fix, and 200 so Stripe does not retry-storm it.
      // The error's own message names src/lib/legal.ts.
      reportError('webhook.stripe', err, {
        orgId: org.id,
        subscriptionId: subscription.id,
        step: 'legal_footer',
      });
      return NextResponse.json({ received: true, skipped: 'legal_footer_unfilled' });
    }

    // The attempt was already counted by the claim, so there is no bookkeeping
    // to do here — which is the point: a send that dies without returning at all
    // (provider stall, platform timeout) has consumed its attempt just the same.
    // Its own context so a Resend problem reads as exactly that in the alert.
    // A Resend error can quote the recipient; reportError redacts it.
    reportError('webhook.stripe.send', err, { orgId: org.id, subscriptionId: subscription.id });

    // 5xx on purpose: Stripe retries 5xx with backoff, and the stranded-send
    // path above turns that retry into a real second attempt.
    return NextResponse.json({ error: 'Survey email send failed' }, { status: 500 });
  }

  try {
    await execute(
      `UPDATE survey_responses
       SET survey_email_sent_at = now()
       WHERE stripe_subscription_id = $1 AND org_id = $2`,
      [subscription.id, org.id],
    );
  } catch (err) {
    // The email is already out. A 5xx here would make Stripe retry and send a
    // second copy to someone who just cancelled, so we accept the bookkeeping
    // gap and report it instead: the row now reads as never emailed, so a
    // later redelivery could mail the customer a second time.
    reportError('webhook.stripe', err, {
      orgId: org.id,
      subscriptionId: subscription.id,
      step: 'mark_sent',
    });
  }

  return NextResponse.json({ received: true });
}
