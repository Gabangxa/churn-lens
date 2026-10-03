import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { assertSameOrigin, requireOrgId, clearOrgCookie, revokeAllSessions } from '@/lib/auth';
import { disconnectStripe } from '@/lib/stripe-disconnect';
import type { Polar } from '@polar-sh/sdk';
import { AlreadyCanceledSubscription } from '@polar-sh/sdk/models/errors/alreadycanceledsubscription.js';
import { PolarError } from '@polar-sh/sdk/models/errors/polarerror.js';
import { ResourceNotFound } from '@polar-sh/sdk/models/errors/resourcenotfound.js';
import { getPolar } from '@/lib/polar';
import { LEGAL } from '@/lib/legal';
import { reportError } from '@/lib/report-error';
import { withErrorReporting } from '@/lib/with-error-reporting';

/**
 * Founder-initiated account deletion (POPIA/GDPR erasure right).
 *
 * Takes effect in two stages: this route disconnects billing, stops surveys
 * and signs the org out on every device immediately (bar one billing case,
 * below), and records `deletion_requested_at`; the daily purge job
 * (src/app/api/purge) hard-deletes the org `LEGAL.deletionWindowDays` later.
 * The delay is a real grace period, not a formality — a founder who clicked
 * by accident, or changes their mind, can email support before anything here
 * becomes irreversible. This route never deletes a row.
 */
async function requestAccountDeletion(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  const auth = await requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  // Idempotent: COALESCE keeps the first request's timestamp (and therefore
  // the original purge date) if the founder submits this twice — a retried or
  // double-clicked request must not push the 30-day window back out.
  const org = await queryOne<{
    deletion_requested_at: string;
    polar_subscription_id: string | null;
  }>(
    `UPDATE organizations
     SET deletion_requested_at = COALESCE(deletion_requested_at, now())
     WHERE id = $1
     RETURNING deletion_requested_at, polar_subscription_id`,
    [orgId],
  );

  if (!org) {
    // No org left to disconnect from, but the session cookie still names one
    // that no longer exists — clear it rather than leaving the browser
    // holding a dead credential. (requireOrgId already refuses a session for
    // a missing org, so only a delete racing this request lands here.)
    const response = NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    return clearOrgCookie(response);
  }

  // Stops surveys and revokes Stripe access immediately. The 30-day window
  // that follows is purely a grace period before erasure — the integration
  // itself does not keep working during it.
  //
  // Non-fatal if it throws: deletion_requested_at is already committed above,
  // so the founder's request has already succeeded in the way that matters —
  // failing the whole response here would make them think nothing happened
  // and retry, when actually the org is already on its way out. The purge job
  // disconnects Stripe again itself once the grace period elapses, so a
  // failure here just means it happens then instead of now.
  let stripeDisconnectFailed = false;
  try {
    await disconnectStripe(orgId);
  } catch (err) {
    // No survey goes out meanwhile — the Stripe webhook skips any org with
    // deletion_requested_at set ('deletion_pending'). What stays live until
    // the purge retries is the stored key and the endpoint registered on the
    // founder's Stripe account.
    reportError('settings.account-delete', err, { orgId, step: 'stripe_disconnect' });
    stripeDisconnectFailed = true;
  }

  // Only an org that has reached Polar is looked up there. Every subscription
  // event the webhook applies sets polar_subscription_id, so a NULL means Polar
  // has never told us of one, and asking anyway would let a Polar outage tell a
  // founder who never paid to go cancel a subscription. (An org whose first
  // webhook is still in flight is missed, as it always was.)
  //
  // Non-fatal: the account is marked for deletion and Stripe is disconnected
  // either way. A failure is reported in the response so the UI can tell the
  // founder to also cancel from the billing portal — otherwise Polar keeps
  // billing a subscription we failed to revoke.
  let billing: 'revoke_failed' | undefined;
  if (org.polar_subscription_id && !(await revokeBillableSubscriptions(orgId))) {
    billing = 'revoke_failed';
  }

  // When the Polar revoke failed the UI sends the founder to /api/billing/portal
  // to cancel by hand, and that route needs the session. The account is still
  // usable during the grace window anyway, so keeping the cookie costs nothing.
  const keepSessionForBillingPortal = billing === 'revoke_failed';

  // Otherwise the org is signed out on every device, not just this browser.
  // The founder has asked for their data to be erased; a session left open on
  // some other device would go on showing their customers' survey answers for
  // the whole grace window. This is the same thing logout does, applied to the
  // moment this route already ends this browser's session — it does not change
  // what deletion means (a fresh magic link still signs the founder in until
  // the purge). It is skipped with the cookie in the billing case above: it
  // would end this browser's session too, and only /api/auth/verify can mint
  // a replacement.
  //
  // Non-fatal, like the steps above and for the same reason: the deletion
  // request is already committed. This browser is still signed out below;
  // the response reports that the other devices were not.
  let sessionsRevokeFailed = false;
  if (!keepSessionForBillingPortal) {
    try {
      await revokeAllSessions(orgId);
    } catch (err) {
      // Sessions on other devices keep showing this org's customers' survey
      // answers through the grace window the founder asked to cut short.
      reportError('settings.account-delete', err, { orgId, step: 'session_revoke' });
      sessionsRevokeFailed = true;
    }
  }

  const purgeAfter = new Date(
    new Date(org.deletion_requested_at).getTime() +
      LEGAL.deletionWindowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const response = NextResponse.json({
    ok: true,
    purgeAfter,
    ...(billing ? { billing } : {}),
    ...(stripeDisconnectFailed ? { stripe: 'disconnect_failed' } : {}),
    ...(sessionsRevokeFailed ? { sessions: 'revoke_failed' } : {}),
  });
  return keepSessionForBillingPortal ? response : clearOrgCookie(response);
}

/**
 * Every Polar call here gives up after this long. The SDK sets no deadline of
 * its own, so a stalled api.polar.sh would otherwise hold the founder's
 * deletion request, and a Node socket, open for minutes.
 */
const POLAR_TIMEOUT_MS = 10_000;

/**
 * The statuses Polar can still charge a card under. The rest have ended
 * (canceled, unpaid, incomplete_expired) or never started (incomplete), and
 * revoking an ended one is Polar's 403 AlreadyCanceledSubscription.
 */
const BILLABLE_STATUSES = ['active', 'trialing', 'past_due'] as const;

/**
 * Revoke every subscription Polar could still bill this org for. Returns false
 * when one may still be billing: the list failed, or a revoke did.
 *
 * Asks Polar rather than following organizations.polar_subscription_id. That
 * pointer names the org's latest subscription, which for an ex-subscriber is
 * one that has already ended — revoking it was a 403, reported as a failure
 * that kept the founder signed in everywhere and told them to cancel a
 * subscription that no longer exists — and an org can hold more than one.
 */
async function revokeBillableSubscriptions(orgId: string): Promise<boolean> {
  let polar: Polar;
  const billable: string[] = [];
  try {
    polar = getPolar();
    const pages = await polar.subscriptions.list(
      { externalCustomerId: orgId, status: [...BILLABLE_STATUSES], limit: 100 },
      { timeoutMs: POLAR_TIMEOUT_MS },
    );
    // Every page is read before anything is revoked: a revoked subscription
    // drops out of this status filter, which would shift any later page past
    // rows it had not yet returned.
    for await (const page of pages) {
      for (const subscription of page.result.items) billable.push(subscription.id);
    }
  } catch (err) {
    reportError('settings.account-delete', describePolarFailure('subscriptions.list', err), {
      orgId,
      step: 'polar_list',
    });
    return false;
  }

  // Each one is attempted even after another fails: one fewer subscription
  // billing the founder is worth having whatever happens to the rest.
  let allRevoked = true;
  for (const subscriptionId of billable) {
    try {
      await polar.subscriptions.revoke({ id: subscriptionId }, { timeoutMs: POLAR_TIMEOUT_MS });
    } catch (err) {
      // Already over (the period ran out, or the founder cancelled in the
      // portal a moment ago) or gone: either way it bills nobody, which is
      // what this was for.
      if (err instanceof AlreadyCanceledSubscription || err instanceof ResourceNotFound) continue;
      reportError('settings.account-delete', describePolarFailure('subscriptions.revoke', err), {
        orgId,
        subscriptionId,
        step: 'polar_revoke',
      });
      allRevoked = false;
    }
  }
  return allRevoked;
}

/**
 * A PolarError's message carries Polar's response body, which is Polar's
 * customer data rather than ours to forward into logs and alert email; its
 * class and status say what went wrong. Anything else (a timeout, a refused
 * connection, the missing-token error) is from our side and kept whole.
 */
function describePolarFailure(call: string, err: unknown): unknown {
  if (err instanceof PolarError) {
    return new Error(`Polar ${call} failed: ${err.name} (status ${err.statusCode})`);
  }
  return err;
}

export const POST = withErrorReporting('settings.account-delete', requestAccountDeletion);
