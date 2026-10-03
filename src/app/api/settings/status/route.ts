import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireOrgId } from '@/lib/auth';
import { reportError } from '@/lib/report-error';
import { withErrorReporting } from '@/lib/with-error-reporting';

async function connectionStatus(req: NextRequest) {
  // Outside the try on purpose, and reported all the same: the session check
  // reads the database too, and a throw from it reaches withErrorReporting.
  const auth = await requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  try {
    const org = await queryOne<{
      stripe_api_key_enc: string | null;
      stripe_account_id: string | null;
      deletion_requested_at: string | null;
    }>(
      'SELECT stripe_api_key_enc, stripe_account_id, deletion_requested_at FROM organizations WHERE id = $1',
      [orgId],
    );

    if (!org) {
      return NextResponse.json({ connected: false });
    }

    const connected = !!(org.stripe_api_key_enc || org.stripe_account_id);
    return NextResponse.json({ connected, deletionRequestedAt: org.deletion_requested_at });
  } catch (err) {
    // Not { connected: false }, which this used to answer: that told a
    // connected founder to "Connect Stripe" and told nobody the database was
    // failing. A 500 the page can tell apart, and a report.
    reportError('settings.status', err, { orgId });
    return NextResponse.json({ error: 'Could not load the Stripe connection status.' }, { status: 500 });
  }
}

export const GET = withErrorReporting('settings.status', connectionStatus);
