import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { assertSameOrigin, setOrgCookie } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';
import { sanitizeNext } from '@/lib/next-paths';
import { consumeLoginToken } from '@/lib/login-token';

/**
 * Magic-link sign-in, in two steps: the link in the email (GET) only forwards
 * to a confirm page, and the confirm page's same-origin form (POST) is what
 * uses the link up and mints the session.
 *
 * A GET that signed you in was a login-CSRF primitive. An attacker requests a
 * link for their OWN address and navigates a victim's browser to it — a
 * link, a redirect, an <img> — and the victim is silently signed into the
 * attacker's org, sitting on /onboarding, one paste away from handing over
 * their Stripe key (and with it, their customers' survey answers). It also
 * let mail scanners and link prefetchers, which GET or HEAD every URL in an
 * email, spend a single-use link before the founder ever clicked it.
 *
 * The emailed URL is unchanged (/api/auth/verify?token=...), so links already
 * sitting in inboxes keep working across this deploy, and across a rollback.
 */

function failedSignIn(req: NextRequest): NextResponse {
  // One generic answer for missing, unknown, used and expired: telling them
  // apart would tell a guesser which tokens exist.
  return NextResponse.redirect(redirectUrl('/login?error=expired', req), { status: 303 });
}

/**
 * The link in the email. Inert by design: no database, no cookie. A link
 * scanner may fetch it any number of times (Next answers HEAD with this same
 * handler) and the founder can still sign in afterwards.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return failedSignIn(req);
  return NextResponse.redirect(
    redirectUrl(`/login/confirm?token=${encodeURIComponent(token)}`, req),
    { status: 303 },
  );
}

/**
 * The confirm page's "Sign in" button. The ONLY place a session is ever
 * minted — every other route either requires an existing session
 * (requireOrgId) or has none — so nothing short of a same-origin submission
 * carrying a link that was emailed to a specific inbox can end in a
 * set-cookie.
 *
 * assertSameOrigin runs first: a foreign page's auto-submitting form is the
 * login-CSRF attack itself, and it must be refused before the token is so
 * much as looked up (leaving the link usable by its owner).
 */
export async function POST(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  const token = await readSubmittedToken(req);
  if (!token) return failedSignIn(req);

  const consumed = await consumeLoginToken(token);
  if (!consumed) return failedSignIn(req);

  // Stamped on every real, inbox-verified sign-in: the purge job's
  // abandoned-signup rule (src/app/api/purge) depends on last_login_at
  // surviving as long as this org keeps being used, distinct from
  // login_tokens rows, which the same job deletes a day after they expire
  // regardless of whether anyone ever used them. RETURNING the key in the
  // same statement saves a second round trip for the destination below.
  const org = await queryOne<{ stripe_api_key_enc: string | null }>(
    `UPDATE organizations SET last_login_at = now() WHERE id = $1
     RETURNING stripe_api_key_enc`,
    [consumed.orgId],
  );

  const destination = destinationAfterSignIn(org, consumed.redirectTo);
  const response = NextResponse.redirect(redirectUrl(destination, req), { status: 303 });
  return setOrgCookie(response, consumed.orgId);
}

/**
 * The token from the confirm page's form body. A body that is not a form at
 * all (wrong content type, truncated) is answered like a missing token: the
 * only legitimate caller is our own <form>, so anything else is a client we
 * owe the generic failure, not a 500.
 */
async function readSubmittedToken(req: NextRequest): Promise<string | null> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return null;
  }
  const token = form.get('token');
  return typeof token === 'string' && token !== '' ? token : null;
}

/**
 * Where a founder goes once signed in.
 *
 * No Stripe key yet (brand-new signup, or a founder who never finished
 * connecting) means onboarding, whatever redirect_to says — except that
 * redirect_to may itself BE an onboarding link carrying the plan a
 * pricing-page click chose, in which case it already is the destination.
 *
 * redirect_to is re-validated against the same allow-list /api/auth/request
 * wrote it under rather than trusted as stored. Request is the only writer
 * and allow-lists on the way in, so this is defense in depth — but a row this
 * route trusted blindly would be one bad migration, admin query or future
 * writer away from an open redirect on the one route that hands out a session.
 *
 * A missing org row (deleted out from under a live token) is treated as
 * keyless; the session minted for it fails its next check anyway.
 */
function destinationAfterSignIn(
  org: { stripe_api_key_enc: string | null } | null,
  storedRedirectTo: string | null,
): string {
  const redirectTo = sanitizeNext(storedRedirectTo);
  if (!org?.stripe_api_key_enc) {
    return redirectTo?.startsWith('/onboarding') ? redirectTo : '/onboarding';
  }
  return redirectTo ?? '/dashboard';
}
