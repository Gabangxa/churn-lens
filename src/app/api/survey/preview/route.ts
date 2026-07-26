import { NextRequest, NextResponse } from 'next/server';
import { signSurveyToken } from '@/lib/crypto';
import { requireOrgId } from '@/lib/auth';
import { publicAppUrl, redirectUrl } from '@/lib/app-url';

/**
 * Redirect the logged-in founder to a live preview of their exit survey.
 * The token is marked kind:'preview' — the survey renders normally but
 * submitting it never writes to the database.
 */
export async function GET(req: NextRequest) {
  // Redirects resolve against the public app URL, never req.url — see
  // lib/app-url.ts for why. Unlike the other routes we hard-fail rather than
  // fall back below, because a preview link on the wrong host is useless.
  const appUrl = publicAppUrl();

  const authResult = requireOrgId(req);
  if ('error' in authResult) {
    return NextResponse.redirect(redirectUrl('/onboarding', req));
  }

  if (!appUrl) {
    return NextResponse.json(
      { error: 'Server misconfiguration: app URL is missing or not https. Contact support.' },
      { status: 500 },
    );
  }

  const token = signSurveyToken({
    orgId: authResult.orgId,
    customerId: 'preview',
    subscriptionId: 'preview',
    exp: Date.now() + 60 * 60 * 1000,
    kind: 'preview',
  });

  return NextResponse.redirect(new URL(`/survey/${token}`, appUrl));
}
