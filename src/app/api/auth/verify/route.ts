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
  // regardless of whether anyone ever used them. RETURNING the connection
  // columns in the same statement saves a second round trip for the
  // destination below.
  const org = await queryOne<StripeConnectionColumns>(
    `UPDATE organizations SET last_login_at = now() WHERE id = $1
     RETURNING stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc`,
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

/** The organizations columns that say whether Stripe is fully connected. */
interface StripeConnectionColumns {
  stripe_api_key_enc: string | null;
  stripe_webhook_id: string | null;
  stripe_webhook_secret_enc: string | null;
}

/**
 * Where a founder goes once signed in.
 *
 * Onboarding until the org is actually connected — a Stripe key stored AND
 * ChurnLens's webhook registered on that account, with the signing secret the
 * webhook verifies its events with — whatever redirect_to says. No key means
 * a brand-new signup; a key with no endpoint is what a connect that failed
 * half-way used to leave behind (it saved the key before registering the
 * webhook), so Stripe never calls us. Either way no survey goes out until
 * connect is finished, and onboarding is the page that finishes it. The
 * exception is a redirect_to that is itself an onboarding link carrying the
 * plan a pricing-page click chose: that already is the destination.
 *
 * The same test as the dashboard's "Stripe setup is incomplete" line
 * (stripeWebhookRegistered in src/app/dashboard/page.tsx), so sign-in and the
 * dashboard never disagree about whether an org is connected.
 *
 * redirect_to is re-validated against the same allow-list /api/auth/request
 * wrote it under rather than trusted as stored. Request is the only writer
 * and allow-lists on the way in, so this is defense in depth — but a row this
 * route trusted blindly would be one bad migration, admin query or future
 * writer away from an open redirect on the one route that hands out a session.
 *
 * A missing org row (deleted out from under a live token) is treated as not
 * connected; the session minted for it fails its next check anyway.
 */
function destinationAfterSignIn(
  org: StripeConnectionColumns | null,
  storedRedirectTo: string | null,
): string {
  const redirectTo = sanitizeNext(storedRedirectTo);
  const fullyConnected = !!(org?.stripe_api_key_enc && org.stripe_webhook_id && org.stripe_webhook_secret_enc);
  if (!fullyConnected) {
    return redirectTo?.startsWith('/onboarding') ? redirectTo : '/onboarding';
  }
  return redirectTo ?? '/dashboard';
}
