import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { queryOne, execute } from '@/lib/db';
import { signSurveyToken } from '@/lib/crypto';
import { requireOrgId } from '@/lib/auth';
import { checkRateLimit } from '@/lib/ratelimit';
import { sendSurveyEmail } from '@/lib/survey-email';
import { loadSurveyConfig } from '@/lib/survey-config';

/**
 * Send the founder a test exit survey at their own email — exercises the
 * real email → survey → dashboard loop. The response row is flagged is_test
 * so it never counts toward stats, themes, digests, or the free-tier cap.
 */
export async function POST(req: NextRequest) {
  const authResult = requireOrgId(req);
  if ('error' in authResult) return authResult.error;
  const { orgId } = authResult;

  const rl = checkRateLimit(`testsurvey:${orgId}`, 3, 3600_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Test survey limit reached. Try again in an hour.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  const owner = await queryOne<{ email: string; name: string | null }>(
    `SELECT email, name FROM users WHERE org_id = $1 AND role = 'owner' LIMIT 1`,
    [orgId],
  );
  if (!owner?.email) {
    return NextResponse.json(
      { error: 'No owner email on file. Reconnect Stripe from onboarding first.' },
      { status: 422 },
    );
  }

  // Unique fake subscription id keeps the real idempotency constraint intact.
  const testSubscriptionId = `test_${randomUUID()}`;

  const token = signSurveyToken({
    orgId,
    customerId: 'test',
    subscriptionId: testSubscriptionId,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    kind: 'test',
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl || !appUrl.startsWith('https://')) {
    return NextResponse.json(
      { error: 'Server misconfiguration: app URL is missing or not https. Contact support.' },
      { status: 500 },
    );
  }

  try {
    await execute(
      `INSERT INTO survey_responses
         (org_id, customer_email, customer_name, stripe_subscription_id, mrr_lost, token, is_test)
       VALUES ($1, $2, $3, $4, 0, $5, true)`,
      [orgId, owner.email, owner.name ?? 'Test customer', testSubscriptionId, token],
    );

    const config = await loadSurveyConfig(orgId);

    await sendSurveyEmail({
      to: owner.email,
      customerName: owner.name,
      surveyUrl: `${appUrl}/survey/${token}`,
      optOutUrl: `${appUrl}/api/survey/opt-out?token=${token}`,
      isTest: true,
      displayName: config.displayName,
    });
  } catch (err) {
    console.error('Test survey send failed:', err);
    return NextResponse.json({ error: 'Failed to send test survey.' }, { status: 500 });
  }

  return NextResponse.json({ success: true, sentTo: owner.email });
}
