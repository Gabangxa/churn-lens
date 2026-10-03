import { NextRequest, NextResponse } from 'next/server';
import { assertSameOrigin, clearOrgCookie, requireOrgId, revokeAllSessions } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';
import { reportError } from '@/lib/report-error';

/**
 * Log out: end the org's sessions on every device, clear this browser's
 * cookie, and send the user back to the landing page.
 *
 * Everywhere, not just here. Deleting one browser's cookie did nothing about
 * a copy of it held anywhere else — a forgotten shared machine, or a stolen
 * cookie, which is the very case someone logs out to deal with.
 *
 * POST-only on purpose. As a GET this was a one-click CSRF target — any
 * third-party page could log a user out with an <img src> or a link
 * prefetch, and SameSite=Lax does not stop a top-level GET. Callers submit
 * a form, so it still works with JavaScript disabled. The Origin/Sec-Fetch-Site
 * check below is a second, independent layer: a plain <form method=POST> from
 * a foreign page still carries the Lax cookie on a top-level submit, which
 * this catches even though SameSite alone would not. That matters more now
 * that a forged logout would sign the founder out on every device.
 */
export async function POST(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  // Only a session that still counts may sign the org out everywhere. An
  // expired, revoked or forged cookie is just cleared from this browser below:
  // a stale credential must not double as a way to end everyone else's.
  //
  // orgId is known only once the session check has passed; a failure of the
  // check itself is reported without it.
  let orgId: string | undefined;
  try {
    const auth = await requireOrgId(req);
    if ('orgId' in auth) {
      orgId = auth.orgId;
      await revokeAllSessions(orgId);
    }
  } catch (err) {
    // This browser is still signed out — clearing its cookie needs no
    // database. What failed is ending the org's other sessions, and the
    // founder has to hear that rather than land on the home page as if it
    // had worked: they may be logging out precisely because of another device.
    // Reported as well as answered: the founder is told, but a database that
    // cannot take this write is everyone's problem, not just theirs.
    reportError('auth.logout', err, { orgId });
    const response = NextResponse.json(
      {
        error:
          'You are signed out of this browser, but we could not sign you out of your other devices. Sign in again and log out to retry.',
      },
      { status: 500 },
    );
    return clearOrgCookie(response);
  }

  // 303 forces the browser to follow with GET; a 307 would replay the POST.
  const response = NextResponse.redirect(redirectUrl('/', req), { status: 303 });
  return clearOrgCookie(response);
}
