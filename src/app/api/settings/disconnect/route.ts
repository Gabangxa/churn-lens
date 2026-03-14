import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';
import { decryptApiKey } from '@/lib/crypto';
import { requireOrgId, clearOrgCookie } from '@/lib/auth';
import Stripe from 'stripe';

export async function DELETE(req: NextRequest) {
  const auth = requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  try {
    const supabase = getAdminClient();

    const { data: org, error: fetchError } = await supabase
      .from('organizations')
      .select('stripe_api_key_enc, stripe_account_id')
      .eq('id', orgId)
      .single();

    if (fetchError || !org) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    if (org.stripe_api_key_enc) {
      const apiKey = decryptApiKey(org.stripe_api_key_enc);
      const stripeClient = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });

      const webhooks = await stripeClient.webhookEndpoints.list({ limit: 100 });
      await Promise.all(
        webhooks.data.map((wh) => stripeClient.webhookEndpoints.del(wh.id)),
      );
    }

    const { error: updateError } = await supabase
      .from('organizations')
      .update({ stripe_api_key_enc: null, stripe_account_id: null })
      .eq('id', orgId);

    if (updateError) {
      console.error('Failed to clear Stripe data:', updateError);
      return NextResponse.json({ error: 'Failed to disconnect.' }, { status: 500 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    const response = NextResponse.redirect(`${appUrl}/onboarding`, { status: 303 });
    return clearOrgCookie(response);
  } catch (err) {
    console.error('Disconnect error:', err);
    return NextResponse.json({ error: 'Failed to disconnect. Could not clean up Stripe webhooks.' }, { status: 500 });
  }
}
