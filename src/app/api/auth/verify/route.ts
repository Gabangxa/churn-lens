import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { hashLoginToken } from '@/lib/crypto';
import { setOrgCookie } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';

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

  const org = await queryOne<{ stripe_api_key_enc: string | null }>(
    'SELECT stripe_api_key_enc FROM organizations WHERE id = $1',
    [row.org_id],
  );

  // No key yet (brand-new signup, or a founder who never finished connecting)
  // means onboarding is where they belong regardless of what redirect_to says
  // — except redirect_to itself may BE an onboarding link carrying the plan a
  // pricing-page click chose, in which case it already is the destination.
  const destination = !org?.stripe_api_key_enc
    ? (row.redirect_to?.startsWith('/onboarding') ? row.redirect_to : '/onboarding')
    : (row.redirect_to ?? '/dashboard');

  const response = NextResponse.redirect(redirectUrl(destination, req), { status: 303 });
  return setOrgCookie(response, row.org_id);
}
