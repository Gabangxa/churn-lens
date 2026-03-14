import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireOrgId } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const auth = requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  try {
    const org = await queryOne<{ stripe_api_key_enc: string | null; stripe_account_id: string | null }>(
      'SELECT stripe_api_key_enc, stripe_account_id FROM organizations WHERE id = $1',
      [orgId],
    );

    if (!org) {
      return NextResponse.json({ connected: false });
    }

    const connected = !!(org.stripe_api_key_enc || org.stripe_account_id);
    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
