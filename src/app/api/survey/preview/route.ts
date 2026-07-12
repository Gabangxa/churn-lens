import { NextRequest, NextResponse } from 'next/server';
import { signSurveyToken } from '@/lib/crypto';
import { requireOrgId } from '@/lib/auth';

/**
 * Redirect the logged-in founder to a live preview of their exit survey.
 * The token is marked kind:'preview' — the survey renders normally but
 * submitting it never writes to the database.
 */
export async function GET(req: NextRequest) {
  const authResult = requireOrgId(req);
  if ('error' in authResult) {
    return NextResponse.redirect(new URL('/onboarding', req.url));
  }

  const token = signSurveyToken({
    orgId: authResult.orgId,
    customerId: 'preview',
    subscriptionId: 'preview',
    exp: Date.now() + 60 * 60 * 1000,
    kind: 'preview',
  });

  return NextResponse.redirect(new URL(`/survey/${token}`, req.url));
}
