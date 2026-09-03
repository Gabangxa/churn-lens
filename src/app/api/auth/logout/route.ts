import { NextRequest, NextResponse } from 'next/server';
import { assertSameOrigin, clearOrgCookie } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';

/**
 * Log out: clear the org session cookie and send the user back to the
 * landing page.
 *
 * POST-only on purpose. As a GET this was a one-click CSRF target — any
 * third-party page could log a user out with an <img src> or a link
 * prefetch, and SameSite=Lax does not stop a top-level GET. Callers submit
 * a form, so it still works with JavaScript disabled. The Origin/Sec-Fetch-Site
 * check below is a second, independent layer: a plain <form method=POST> from
 * a foreign page still carries the Lax cookie on a top-level submit, which
 * this catches even though SameSite alone would not.
 */
export async function POST(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  // 303 forces the browser to follow with GET; a 307 would replay the POST.
  const response = NextResponse.redirect(redirectUrl('/', req), { status: 303 });
  return clearOrgCookie(response);
}
