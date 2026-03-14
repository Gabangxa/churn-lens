import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { encryptApiKey } from '@/lib/crypto';
import { setOrgCookie } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, orgId } = body;

    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json({ error: 'API key is required.' }, { status: 400 });
    }

    if (!orgId || typeof orgId !== 'string') {
      return NextResponse.json({ error: 'Organization ID is required.' }, { status: 400 });
    }

    if (!apiKey.startsWith('rk_')) {
      return NextResponse.json(
        { error: 'Please provide a Stripe restricted API key (starts with rk_).' },
        { status: 400 },
      );
    }

    const encrypted = encryptApiKey(apiKey);

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE id = $1',
      [orgId],
    );

    if (existing) {
      await query(
        'UPDATE organizations SET stripe_api_key_enc = $1 WHERE id = $2',
        [encrypted, orgId],
      );
    } else {
      await query(
        `INSERT INTO organizations (id, name, stripe_api_key_enc) VALUES ($1, $2, $3)`,
        [orgId, 'My Organization', encrypted],
      );
    }

    const response = NextResponse.json({ success: true });
    return setOrgCookie(response, orgId);
  } catch (err) {
    console.error('Onboarding connect error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
