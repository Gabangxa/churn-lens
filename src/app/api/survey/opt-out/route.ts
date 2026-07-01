import { NextRequest, NextResponse } from 'next/server';
import { verifySurveyToken } from '@/lib/crypto';
import { queryOne, execute } from '@/lib/db';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';

/**
 * One-click unsubscribe from exit surveys (CAN-SPAM).
 *
 * The token is HMAC-verified but its expiry is intentionally ignored — an
 * unsubscribe link must keep working after the 7-day survey window closes. The
 * token payload has no email, so we resolve it from the survey_responses row the
 * webhook created, then record a suppression keyed by (org_id, customer_email).
 *
 * Note: this suppresses on GET, so an email client that pre-fetches links could
 * auto-unsubscribe. Acceptable here (reversible, low-harm); swap to a confirm
 * button + POST if that becomes a problem.
 */
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`optout:${clientIp(req)}`, 20, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  const token = req.nextUrl.searchParams.get('token');
  const payload = token ? verifySurveyToken(token) : null;

  // Always land on the same confirmation page — don't leak whether a token was valid.
  const done = NextResponse.redirect(new URL('/survey/unsubscribed', req.url));

  if (!token || !payload) return done;

  const row = await queryOne<{ org_id: string; customer_email: string }>(
    'SELECT org_id, customer_email FROM survey_responses WHERE token = $1 AND org_id = $2',
    [token, payload.orgId],
  );

  if (row) {
    await execute(
      `INSERT INTO unsubscribes (org_id, customer_email) VALUES ($1, $2)
       ON CONFLICT (org_id, customer_email) DO NOTHING`,
      [row.org_id, row.customer_email],
    );
  }

  return done;
}
