import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { hashLoginToken } from '@/lib/crypto';
import { setOrgCookie } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';
import { sanitizeNext } from '@/lib/next-paths';

/**
 * Consume a magic-link token and establish the session. The ONLY place a
 * session is ever minted — every other route either requires an existing
 * session (requireOrgId) or has none. That is what closes the account
 * takeover this route accompanies: nothing upstream of a proven click on a
 * link sent to a specific inbox can end in a set-cookie.
 *
 * Single-use is enforced atomically by the UPDATE guard (used_at IS NULL) rather
 * than a check-then-act, so a replayed or concurrent second click can't log in.
 * On any failure (missing/invalid/expired/already-used) we redirect to /login
 * with a generic error rather than distinguishing cases.
 */
export async function GET(req: NextRequest) {
  const fail = () =>
    NextResponse.redirect(redirectUrl('/login?error=expired', req), { status: 303 });

  const token = req.nextUrl.searchParams.get('token');
  if (!token) return fail();

  const row = await queryOne<{ org_id: string; redirect_to: string | null }>(
    `UPDATE login_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING org_id, redirect_to`,
    [hashLoginToken(token)],
  );

  if (!row) return fail();

  // Stamped in the same statement as the lookup (UPDATE ... RETURNING, not a
  // separate SELECT + UPDATE): this is the one place a real, inbox-verified
  // sign-in happens, and the purge job's abandoned-signup rule (src/app/api/
  // purge) depends on last_login_at surviving as long as this org keeps being
  // used, distinct from login_tokens rows, which the same job deletes a day
  // after they expire regardless of whether anyone ever used them.
  const org = await queryOne<{ stripe_api_key_enc: string | null }>(
    'UPDATE organizations SET last_login_at = now() WHERE id = $1 RETURNING stripe_api_key_enc',
    [row.org_id],
  );

  // Re-validate redirect_to against the same allow-list /api/auth/request wrote
  // it under, rather than trusting the stored value verbatim. Today request is
  // the only writer and it already allow-lists on the way in, so this is
  // defense in depth, not the primary guard — but a row this route trusts
  // blindly is one bad migration, admin query, or future writer away from an
  // open redirect on the one route that also hands out a session.
  const validRedirectTo = sanitizeNext(row.redirect_to);

  // No key yet (brand-new signup, or a founder who never finished connecting)
  // means onboarding is where they belong regardless of what redirect_to says
  // — except redirect_to itself may BE an onboarding link carrying the plan a
  // pricing-page click chose, in which case it already is the destination.
  const destination = !org?.stripe_api_key_enc
    ? (validRedirectTo?.startsWith('/onboarding') ? validRedirectTo : '/onboarding')
    : (validRedirectTo ?? '/dashboard');

  const response = NextResponse.redirect(redirectUrl(destination, req), { status: 303 });
  return setOrgCookie(response, row.org_id);
}
