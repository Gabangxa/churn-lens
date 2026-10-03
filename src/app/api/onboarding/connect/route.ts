import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { query, queryOne } from '@/lib/db';
import { encryptApiKey } from '@/lib/crypto';
import { assertSameOrigin, requireOrgId, clearOrgCookie } from '@/lib/auth';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';
import { reportError } from '@/lib/report-error';
import { fetchStripeBusinessName } from '@/lib/stripe-business-name';
import { LEGAL_DOCS_VERSION } from '@/lib/legal-version';

/**
 * Attach (or replace) the signed-in org's Stripe restricted key and register
 * ChurnLens's webhook on the customer's Stripe account.
 *
 * A session is required — this route no longer creates orgs or users, and no
 * longer accepts an email. Both of those used to be trusted from the request
 * body with nothing proving the caller owned that address; that was the
 * account-takeover hole this route was rewritten to close. Signup now happens
 * only in /api/auth/request, and a session is minted only in /api/auth/verify.
 *
 * Connecting also requires accepting the current Terms of Service and Data
 * Processing Agreement (see LEGAL_DOCS_VERSION). The stored key is what starts
 * processing the org's customers' personal information on its behalf, which
 * POPIA s21 only allows under a written operator contract — so no key is
 * stored without an acceptance recorded in the same statement.
 */
export async function POST(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  const authResult = await requireOrgId(req);
  if ('error' in authResult) return authResult.error;
  const { orgId } = authResult;

  // Throttle webhook registration per IP, independent of the per-org session.
  // Checked AFTER requireOrgId: this bucket is keyed by IP, and an anonymous
  // caller who fails the session check must not be able to spend a founder's
  // (or a shared-IP neighbor's) budget with requests that were always going
  // to 401. Deferring it costs an anonymous caller nothing either:
  // requireOrgId turns away every cookie we did not sign before it does any
  // I/O, and only a genuine session costs it one database read.
  const rl = checkRateLimit(`onboard:${clientIp(req)}`, 8, 600_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a minute and try again.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  let apiKey: unknown;
  let acceptedLegalVersion: unknown;
  try {
    ({ apiKey, acceptedLegalVersion } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  // Checked before the key is even looked at: without an agreement in place
  // there is nothing to process it under. The form sends the version string it
  // was built with, not a bare `true`, so a page loaded before a version bump
  // cannot agree to wording the founder was never shown — it gets told to
  // reload instead. Whatever else the body carries (a timestamp, say) is
  // ignored: the acceptance time below is the database's clock.
  if (acceptedLegalVersion !== LEGAL_DOCS_VERSION) {
    const error =
      typeof acceptedLegalVersion === 'string' && acceptedLegalVersion !== ''
        ? 'The Terms of Service or Data Processing Agreement changed after this page loaded. Reload the page to review and accept the current version.'
        : 'You need to accept the Terms of Service and Data Processing Agreement to connect Stripe. If you do not see the checkbox, reload the page.';
    return NextResponse.json({ error }, { status: 400 });
  }

  try {
    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json({ error: 'API key is required.' }, { status: 400 });
    }

    if (!apiKey.startsWith('rk_')) {
      return NextResponse.json(
        { error: 'Please provide a Stripe restricted API key (starts with rk_).' },
        { status: 400 },
      );
    }

    const existing = await queryOne<{ id: string; stripe_webhook_id: string | null }>(
      'SELECT id, stripe_webhook_id FROM organizations WHERE id = $1',
      [orgId],
    );

    if (!existing) {
      // requireOrgId already refuses a session whose org row is gone, so this
      // is only reachable if the org was deleted between that check and this
      // read. There is nothing to attach a key to, and creating a fresh org
      // here would silently reintroduce the "connect without proving who you
      // are" hole this route was rewritten to close — so this forces a real
      // re-login instead.
      const response = NextResponse.json(
        { error: 'Session is no longer valid. Please log in again.' },
        { status: 401 },
      );
      return clearOrgCookie(response);
    }

    const customerStripe = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });

    // The account's public business name, for survey copy when no display
    // name is set (POPIA s18). Optional: most keys made per our instructions
    // cannot read the account, and that must not fail the connect or count
    // against the key — fetchStripeBusinessName returns null instead.
    const businessName = await fetchStripeBusinessName(customerStripe, orgId);

    const encrypted = encryptApiKey(apiKey);
    // One statement, so the row never pairs the new key with stale state:
    //  - stripe_key_invalid_at: a new key is not one Stripe has rejected, so the
    //    dashboard's "reconnect Stripe" warning (set by the Stripe webhook) is
    //    cleared. Nothing here proves the key works — with a webhook already
    //    registered no customer call is made — so the next cancellation
    //    re-flags it if it does not.
    //  - stripe_business_name: always overwritten, NULL included. The new key
    //    may belong to a different Stripe account, and surveys must not go out
    //    naming the previous one; the webhook retries the lookup lazily.
    //  - legal_accepted_*: the Terms/DPA acceptance is written in the SAME
    //    statement as the key, so a stored key can never exist without one
    //    beside it — even if the webhook registration below then fails, the
    //    founder did agree. now() is the database's clock, never a
    //    client-supplied time. A re-accept of the version already on record
    //    keeps the original time: the record should say when the founder first
    //    agreed to this wording, and replacing a key is not a new agreement to
    //    it. In a SET clause the right-hand columns are the row's values BEFORE
    //    this update, and the organizations_legal_acceptance_pair_check
    //    constraint guarantees a matching version always has a time beside it.
    //    POST /api/legal/accept applies the same rule.
    await query(
      `UPDATE organizations
       SET stripe_api_key_enc = $1,
           stripe_key_invalid_at = NULL,
           stripe_business_name = $2,
           legal_accepted_at = CASE WHEN legal_accepted_version = $3 THEN legal_accepted_at ELSE now() END,
           legal_accepted_version = $3
       WHERE id = $4`,
      [encrypted, businessName, LEGAL_DOCS_VERSION, orgId],
    );

    // Register ChurnLens webhook on the customer's Stripe account (only if not already done).
    // Stripe rejects webhook URLs without an explicit https scheme, so fail fast here
    // instead of surfacing a confusing Stripe error to the user.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl || !appUrl.startsWith('https://')) {
      // Server misconfiguration: every founder's onboarding fails until
      // someone fixes the variable, so this is reported, not just logged.
      reportError(
        'onboarding.connect',
        new Error(
          `NEXT_PUBLIC_APP_URL is ${appUrl ? `"${appUrl}" (must start with https://)` : 'not set'} — cannot register Stripe webhook.`,
        ),
        { orgId, step: 'app_url' },
      );
      return NextResponse.json(
        { error: 'Server misconfiguration: app URL is missing or not https. Contact support.' },
        { status: 500 },
      );
    }

    if (!existing.stripe_webhook_id) {
      let webhookEndpoint: Stripe.WebhookEndpoint;
      try {
        webhookEndpoint = await customerStripe.webhookEndpoints.create({
          url: `${appUrl}/api/webhooks/stripe/${orgId}`,
          enabled_events: ['customer.subscription.deleted'],
          description: 'ChurnLens exit survey trigger',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        // Only blame the key when Stripe actually reported an auth/permission
        // problem — other failures (bad URL, network) are not the user's fault.
        const isKeyProblem =
          err instanceof Stripe.errors.StripeAuthenticationError ||
          err instanceof Stripe.errors.StripePermissionError;
        if (isKeyProblem) {
          // The founder's input, answered with a hint below — not an alert.
          // Stripe masks the key in this message.
          console.warn(`Stripe rejected the key during webhook registration for org ${orgId}: ${message}`);
        } else {
          reportError('onboarding.connect', err, { orgId, step: 'stripe_webhook' });
        }
        const hint = isKeyProblem
          ? ' Check that your key is valid and has Webhook Endpoints write permission.'
          : '';
        return NextResponse.json(
          { error: `Failed to register Stripe webhook: ${message}.${hint}` },
          { status: 422 },
        );
      }

      await query(
        `UPDATE organizations
         SET stripe_webhook_id = $1, stripe_webhook_secret_enc = $2
         WHERE id = $3`,
        [webhookEndpoint.id, encryptApiKey(webhookEndpoint.secret!), orgId],
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    reportError('onboarding.connect', err, { orgId });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
