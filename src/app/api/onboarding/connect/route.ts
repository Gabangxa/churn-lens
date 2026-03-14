import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';
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
    const supabase = getAdminClient();

    const { data: existing } = await supabase
      .from('organizations')
      .select('id')
      .eq('id', orgId)
      .single();

    let error;

    if (existing) {
      const result = await supabase
        .from('organizations')
        .update({ stripe_api_key_enc: encrypted })
        .eq('id', orgId);
      error = result.error;
    } else {
      const result = await supabase
        .from('organizations')
        .insert({ id: orgId, name: 'My Organization', stripe_api_key_enc: encrypted });
      error = result.error;
    }

    if (error) {
      console.error('Failed to save encrypted key:', error);
      return NextResponse.json({ error: 'Failed to save API key.' }, { status: 500 });
    }

    const response = NextResponse.json({ success: true });
    return setOrgCookie(response, orgId);
  } catch (err) {
    console.error('Onboarding connect error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
