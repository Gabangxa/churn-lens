import { NextRequest, NextResponse } from 'next/server';
import { clearOrgCookie } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';

/**
 * Log out: clear the org session cookie and send the user back to the
 * landing page.
 *
 * POST-only on purpose. As a GET this was a one-click CSRF target — any
 * third-party page could log a user out with an <img src> or a link
 * prefetch, and SameSite=Lax does not stop a top-level GET. Callers submit
 * a form, so it still works with JavaScript disabled.
 */
export async function POST(req: NextRequest) {
  // 303 forces the browser to follow with GET; a 307 would replay the POST.
  const response = NextResponse.redirect(redirectUrl('/', req), { status: 303 });
  return clearOrgCookie(response);
}
