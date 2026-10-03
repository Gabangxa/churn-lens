import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { queryOne, withTransaction } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto';
import { assertSameOrigin, requireOrgId, clearOrgCookie } from '@/lib/auth';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';
import { reportError } from '@/lib/report-error';
import { fetchStripeBusinessName } from '@/lib/stripe-business-name';
import { currentLegalDocsVersion } from '@/lib/legal-version';
import { recordLegalAcceptance } from '@/lib/legal-acceptance';

/** The Stripe calls this route makes, as named in operator reports. */
type StripeStep = 'stripe_key_check' | 'stripe_webhook_lookup' | 'stripe_webhook';

const STRIPE_STEP_FAILURE: Record<StripeStep, string> = {
  stripe_key_check: 'Could not check this key with Stripe',
  stripe_webhook_lookup: 'Could not check your existing Stripe webhook',
  stripe_webhook: 'Failed to register Stripe webhook',
};

/**
 * Whether Stripe refused the key itself: 401 (revoked, rolled, mistyped) or
 * 403 (a restricted key missing a permission). The founder's to fix, so it is
 * answered in the form and never alerts. Same classification as the Stripe
 * webhook uses to flag a stored key.
 */
function isKeyRejected(err: unknown): err is Stripe.errors.StripeError {
  return (
    err instanceof Stripe.errors.StripeAuthenticationError ||
    err instanceof Stripe.errors.StripePermissionError
  );
}

/** Stripe's 404 resource_missing: the object is not visible to this key. */
function isResourceMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'resource_missing';
}

/**
 * The answer to a Stripe call that failed before anything was stored. Every
 * caller returns it as is, so "Nothing was saved" is true of each.
 */
function stripeFailureResponse(err: unknown, orgId: string, step: StripeStep): NextResponse {
  // Stripe's own wording, without its final full stop so it reads inside ours.
  const detail = (err instanceof Error ? err.message : 'Unknown error').replace(/[.\s]+$/, '');
  if (isKeyRejected(err)) {
    // Stripe masks the key in its messages, so this log and the founder's
    // error carry at most its last four characters.
    console.warn(`Stripe rejected the key at ${step} for org ${orgId}: ${detail}`);
    return NextResponse.json(
      {
        error:
          `Stripe rejected this key (${detail}). Check that it is a restricted key that has not been ` +
          'revoked, with customers:read, subscriptions:read and webhooks:write. Nothing was saved.',
      },
      { status: 422 },
    );
  }
  // Stripe down, the network, or a request Stripe refused for a reason that
  // is not the key: not the founder's doing, and if it persists nobody can
  // connect, so the operator hears about it.
  reportError('onboarding.connect', err, { orgId, step });
  return NextResponse.json(
    { error: `${STRIPE_STEP_FAILURE[step]} (${detail}). Nothing was saved — please try again.` },
    { status: 502 },
  );
}

/**
 * Best-effort removal of a webhook endpoint this route no longer wants.
 * Never throws: the connect's outcome is already decided, and the worst case
 * is an endpoint someone removes by hand, which the warning names (by id —
 * never the key).
 */
async function deleteEndpointBestEffort(
  stripeClient: Stripe,
  endpointId: string,
  orgId: string,
  why: string,
): Promise<void> {
  try {
    await stripeClient.webhookEndpoints.del(endpointId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `Stripe webhook endpoint ${endpointId} for org ${orgId} (${why}) was not deleted and may need ` +
        `removing by hand: ${message}`,
    );
  }
}

/**
 * Attach (or replace) the signed-in org's Stripe restricted key and make sure
 * a ChurnLens webhook endpoint exists in that key's Stripe account and mode.
 *
 * A session is required — this route no longer creates orgs or users, and no
 * longer accepts an email. Both of those used to be trusted from the request
 * body with nothing proving the caller owned that address; that was the
 * account-takeover hole this route was rewritten to close. Signup now happens
 * only in /api/auth/request, and a session is minted only in /api/auth/verify.
 *
 * Connecting also requires accepting the current Terms of Service and Data
 * Processing Agreement (currentLegalDocsVersion()). The stored key is what
 * starts processing the org's customers' personal information on its behalf,
 * which POPIA s21 only allows under a written operator contract — so no key is
 * stored without an acceptance recorded in the same transaction.
 *
 * Nothing is stored until Stripe has accepted the key AND an endpoint the key
 * can see is settled. A key stored on its own — rejected by Stripe, or with
 * no endpoint in its account and mode — is an org no cancellation can ever be
 * surveyed for, which the dashboard used to call "sending automatically".
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
  if (acceptedLegalVersion !== currentLegalDocsVersion()) {
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

    const existing = await queryOne<{
      id: string;
      stripe_api_key_enc: string | null;
      stripe_webhook_id: string | null;
      stripe_webhook_secret_enc: string | null;
    }>(
      'SELECT id, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc FROM organizations WHERE id = $1',
      [orgId],
    );

    if (!existing) {
      // requireOrgId already refuses a session whose org row is gone, so this
      // is only reachable if the org was deleted between that check and this
      // read. There is nothing to attach a key to, and creating a fresh org
      // here would silently reintroduce the "connect without proving who you
      // are" hole this route was rewritten to close — so this forces a real
      // re-login instead.
      return sessionGoneResponse();
    }

    // Stripe rejects webhook URLs without an explicit https scheme, so fail
    // fast — before any Stripe call — instead of surfacing a confusing Stripe
    // error to the founder.
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

    const customerStripe = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });

    // 1. Does Stripe accept the key for what surveys need? Listing one
    //    customer exercises customers:read, which every cancellation's lookup
    //    uses. The account read below cannot stand in for this: onboarding
    //    never asks for that permission, so its 403 means nothing.
    try {
      await customerStripe.customers.list({ limit: 1 });
    } catch (err) {
      return stripeFailureResponse(err, orgId, 'stripe_key_check');
    }

    // 2. An endpoint in the key's own account and mode. An endpoint lives in
    //    one account and one mode, and the webhook reads each event's
    //    customer with the stored key — so the org's existing endpoint is
    //    only any use if the NEW key can see it. Not visible (404) means the
    //    key is for another account, or the other of test/live: register one
    //    where the key is, and retire the old one once the new connection is
    //    saved.
    let kept: { id: string; secretEnc: string } | null = null;
    if (existing.stripe_webhook_id && existing.stripe_webhook_secret_enc) {
      try {
        await customerStripe.webhookEndpoints.retrieve(existing.stripe_webhook_id);
        kept = { id: existing.stripe_webhook_id, secretEnc: existing.stripe_webhook_secret_enc };
      } catch (err) {
        if (!isResourceMissing(err)) return stripeFailureResponse(err, orgId, 'stripe_webhook_lookup');
      }
    }

    let webhookId: string;
    let webhookSecretEnc: string;
    // Set only when an endpoint is registered below: the one to remove if the
    // save fails, and the org's previous one to retire once it succeeds.
    let createdEndpointId: string | null = null;
    let replacedEndpointId: string | null = null;
    if (kept) {
      webhookId = kept.id;
      webhookSecretEnc = kept.secretEnc;
    } else {
      replacedEndpointId = existing.stripe_webhook_id;
      let endpoint: Stripe.WebhookEndpoint;
      try {
        endpoint = await customerStripe.webhookEndpoints.create({
          url: `${appUrl}/api/webhooks/stripe/${orgId}`,
          enabled_events: ['customer.subscription.deleted'],
          description: 'ChurnLens exit survey trigger',
        });
      } catch (err) {
        return stripeFailureResponse(err, orgId, 'stripe_webhook');
      }
      createdEndpointId = endpoint.id;
      webhookId = endpoint.id;
      try {
        // Stripe returns the signing secret only on create. Inside a try so
        // that an endpoint we cannot verify events from is not left behind.
        if (!endpoint.secret) throw new Error('Stripe returned no signing secret for the new webhook endpoint.');
        webhookSecretEnc = encryptApiKey(endpoint.secret);
      } catch (err) {
        await deleteEndpointBestEffort(customerStripe, endpoint.id, orgId, 'unusable new endpoint');
        throw err;
      }
    }

    // 3. The account's public business name, for survey copy when no display
    //    name is set (POPIA s18). Optional: most keys made per our
    //    instructions cannot read the account, and that must not fail the
    //    connect or count against the key — it returns null instead.
    const businessName = await fetchStripeBusinessName(customerStripe, orgId);

    // 4. One transaction, so the row never pairs the new key with stale state:
    //  - the webhook columns: the endpoint settled above, in this key's
    //    account and mode, always beside the key that can read its events.
    //  - stripe_key_invalid_at: Stripe has just accepted this key, so the
    //    dashboard's "reconnect Stripe" warning is cleared. A later failure
    //    (a permission removed) is re-flagged by the webhook.
    //  - stripe_business_name: always overwritten, NULL included. The new key
    //    may belong to a different Stripe account, and surveys must not go out
    //    naming the previous one; the webhook retries the lookup lazily.
    //  - the Terms/DPA acceptance commits or rolls back WITH the key, so a
    //    stored key can never exist without one beside it, and a connect that
    //    fails records neither. recordLegalAcceptance (shared with POST
    //    /api/legal/accept) adds the version to legal_acceptances, which keeps
    //    every earlier version, and updates the organizations cache on the
    //    database clock; reconnecting under the version already on record
    //    keeps the original time, because replacing a key is not a new
    //    agreement to the same wording.
    let updated: number;
    try {
      updated = await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          `UPDATE organizations
           SET stripe_api_key_enc = $1,
               stripe_webhook_id = $2,
               stripe_webhook_secret_enc = $3,
               stripe_key_invalid_at = NULL,
               stripe_business_name = $4
           WHERE id = $5`,
          [encryptApiKey(apiKey), webhookId, webhookSecretEnc, businessName, orgId],
        );
        // No row, nothing to accept for: recordLegalAcceptance would find
        // none either, and the caller answers the vanished session below.
        if (!rowCount) return 0;
        await recordLegalAcceptance(client, orgId, 'connect');
        return rowCount;
      });
    } catch (err) {
      // Nothing was saved, so an endpoint registered for this attempt would
      // only post events no row can verify. The error itself is reported by
      // the handler below.
      if (createdEndpointId) {
        await deleteEndpointBestEffort(customerStripe, createdEndpointId, orgId, 'connect failed to save');
      }
      throw err;
    }

    if (updated === 0) {
      // The org was deleted while Stripe was being called (see the read above).
      if (createdEndpointId) {
        await deleteEndpointBestEffort(customerStripe, createdEndpointId, orgId, 'org deleted mid-connect');
      }
      return sessionGoneResponse();
    }

    // 5. Only now that the new endpoint is saved: retire the one it replaced.
    //    It lives in the old account or mode, which only the old key can
    //    reach — and that key is often revoked (the usual reason to
    //    reconnect), so this is best-effort; Stripe disables an endpoint
    //    whose deliveries keep failing, and ours now answer 400 for it.
    if (replacedEndpointId && existing.stripe_api_key_enc) {
      let oldStripe: Stripe | null = null;
      try {
        oldStripe = new Stripe(decryptApiKey(existing.stripe_api_key_enc), {
          apiVersion: '2024-04-10',
          typescript: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `Old Stripe key for org ${orgId} could not be decrypted, so webhook endpoint ${replacedEndpointId} ` +
            `was not deleted and may need removing by hand: ${message}`,
        );
      }
      if (oldStripe) {
        await deleteEndpointBestEffort(oldStripe, replacedEndpointId, orgId, 'replaced by reconnect');
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    reportError('onboarding.connect', err, { orgId });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

/** The org behind a valid session is gone: force a real re-login. */
function sessionGoneResponse(): NextResponse {
  const response = NextResponse.json(
    { error: 'Session is no longer valid. Please log in again.' },
    { status: 401 },
  );
  return clearOrgCookie(response);
}
