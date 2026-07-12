import { NextRequest, NextResponse } from 'next/server';
import { signSurveyToken } from '@/lib/crypto';
import { requireOrgId } from '@/lib/auth';

/**
 * Redirect the logged-in founder to a live preview of their exit survey.
 * The token is marked kind:'preview' — the survey renders normally but
 * submitting it never writes to the database.
 */
export async function GET(req: NextRequest) {
  // Build redirects from the public app URL, not req.url — behind the Railway
  // proxy, req.url's host is the internal address (localhost:$PORT), not the
  // public one. Mirrors the same guard in api/survey/test/route.ts. Falls back
  // to req.url for the auth redirect so a misconfigured env still lands
  // somewhere sane locally.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  const authResult = requireOrgId(req);
  if ('error' in authResult) {
    return NextResponse.redirect(new URL('/onboarding', appUrl?.startsWith('https://') ? appUrl : req.url));
  }

  if (!appUrl || !appUrl.startsWith('https://')) {
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
