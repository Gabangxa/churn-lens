import { NextRequest, NextResponse } from 'next/server';
import { clearOrgCookie } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';

/**
 * Log out: clear the org session cookie and send the user back to the
 * landing page. A GET so it works as a plain <a href> from the app headers.
 */
export async function GET(req: NextRequest) {
  const response = NextResponse.redirect(redirectUrl('/', req), { status: 303 });
  return clearOrgCookie(response);
}
