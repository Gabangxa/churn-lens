import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';
import { requireOrgId } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const auth = requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  try {
    const supabase = getAdminClient();
    const { data: org, error } = await supabase
      .from('organizations')
      .select('stripe_api_key_enc, stripe_account_id')
      .eq('id', orgId)
      .single();

    if (error || !org) {
      return NextResponse.json({ connected: false });
    }

    const connected = !!(org.stripe_api_key_enc || org.stripe_account_id);
    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
