import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { assertSameOrigin, requireOrgId, clearOrgCookie, revokeAllSessions } from '@/lib/auth';
import { disconnectStripe } from '@/lib/stripe-disconnect';
import { getPolar } from '@/lib/polar';
import { LEGAL } from '@/lib/legal';
import { reportError } from '@/lib/report-error';

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
export async function POST(req: NextRequest) {
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
    // Until the purge retries it, this org's webhook can keep firing surveys
    // for an account its founder asked to delete.
    reportError('settings.account-delete', err, { orgId, step: 'stripe_disconnect' });
    stripeDisconnectFailed = true;
  }

  let billing: 'revoke_failed' | undefined;
  if (org.polar_subscription_id) {
    try {
      await getPolar().subscriptions.revoke({ id: org.polar_subscription_id });
    } catch (err) {
      // Non-fatal: the account is marked for deletion and Stripe is
      // disconnected either way. Reported in the response so the UI can tell
      // the founder to also cancel from the billing portal — otherwise Polar
      // keeps billing a subscription we failed to revoke.
      reportError('settings.account-delete', err, { orgId, step: 'polar_revoke' });
      billing = 'revoke_failed';
    }
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
