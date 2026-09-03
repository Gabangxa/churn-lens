import { NextRequest, NextResponse } from 'next/server';
import { verifySurveyToken } from '@/lib/crypto';
import { queryOne, execute } from '@/lib/db';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';
import { redirectUrl } from '@/lib/app-url';

/**
 * One-click unsubscribe from exit surveys (CAN-SPAM / RFC 8058).
 *
 * The token is HMAC-verified but its expiry is intentionally ignored — an
 * unsubscribe link must keep working after the 7-day survey window closes. The
 * token payload has no email, so we resolve it from the survey_responses row the
 * webhook created, then record a suppression keyed by (org_id, customer_email).
 *
 * Shared between GET (a human clicking the link in the email body) and POST
 * (RFC 8058: mail providers that see `List-Unsubscribe` + `List-Unsubscribe-Post:
 * List-Unsubscribe=One-Click` in the headers — see src/lib/survey-email.ts —
 * submit a machine POST to this same URL instead of opening it in a browser).
 * Both suppress identically; only the response shape differs, because only one
 * of them is ever rendered to a person.
 */
async function suppress(token: string | null): Promise<void> {
  const payload = token ? verifySurveyToken(token) : null;
  if (!token || !payload) return;

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
}

export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`optout:${clientIp(req)}`, 20, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  const token = req.nextUrl.searchParams.get('token');

  // Always land on the same confirmation page — don't leak whether a token
  // was valid. Note: this suppresses on GET, so an email client that
  // pre-fetches links could auto-unsubscribe. Acceptable here (reversible,
  // low-harm) — POST below is the real one-click mechanism mail providers use.
  await suppress(token);
  return NextResponse.redirect(redirectUrl('/survey/unsubscribed', req));
}

/**
 * RFC 8058 one-click unsubscribe. A mail provider — not a browser — POSTs
 * here (conventionally with a `List-Unsubscribe=One-Click` body, which this
 * route does not need to read: the token in the URL is the only thing that
 * identifies who is unsubscribing) after seeing List-Unsubscribe-Post in the
 * survey email's headers. It expects a plain 200, never a redirect: nothing
 * renders this response, so sending someone to a page they'll never see would
 * be meaningless, and providers may treat a non-2xx as "click doesn't work".
 */
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`optout:${clientIp(req)}`, 20, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  const token = req.nextUrl.searchParams.get('token');

  // Same "don't leak validity" reasoning as GET: always 200.
  await suppress(token);
  return NextResponse.json({ received: true });
}
