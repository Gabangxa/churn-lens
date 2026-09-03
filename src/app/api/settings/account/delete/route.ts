import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireOrgId, clearOrgCookie } from '@/lib/auth';
import { disconnectStripe } from '@/lib/stripe-disconnect';
import { getPolar } from '@/lib/polar';
import { LEGAL } from '@/lib/legal';

/**
 * Founder-initiated account deletion (POPIA/GDPR erasure right).
 *
 * Takes effect in two stages: this route disconnects billing and stops
 * surveys immediately, and records `deletion_requested_at`; the daily purge
 * job (src/app/api/purge) hard-deletes the org `LEGAL.deletionWindowDays`
 * later. The delay is a real grace period, not a formality — a founder who
 * clicked by accident, or changes their mind, can email support before
 * anything here becomes irreversible. This route never deletes a row.
 */
export async function POST(req: NextRequest) {
  // TODO(auth-merge): add a same-origin (CSRF) check once the concurrent auth
  // rewrite lands. src/lib/auth.ts has no assertSameOrigin (or equivalent) in
  // this worktree yet, and adding one here would collide with that in-flight
  // work rather than build on it.
  const auth = requireOrgId(req);
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
    return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
  }

  // Stops surveys and revokes Stripe access immediately. The 30-day window
  // that follows is purely a grace period before erasure — the integration
  // itself does not keep working during it.
  await disconnectStripe(orgId);

  let billing: 'revoke_failed' | undefined;
  if (org.polar_subscription_id) {
    try {
      await getPolar().subscriptions.revoke({ id: org.polar_subscription_id });
    } catch (err) {
      // Non-fatal: the account is marked for deletion and Stripe is
      // disconnected either way. Reported in the response so the UI can tell
      // the founder to also cancel from the billing portal — otherwise Polar
      // keeps billing a subscription we failed to revoke.
      console.error(`Polar subscription revoke failed for org ${orgId}:`, err);
      billing = 'revoke_failed';
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
  });
  return clearOrgCookie(response);
}
