import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { decryptApiKey } from '@/lib/crypto';
import { requireOrgId, clearOrgCookie } from '@/lib/auth';
import Stripe from 'stripe';

export async function DELETE(req: NextRequest) {
  const auth = requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  try {
    const org = await queryOne<{ stripe_api_key_enc: string | null; stripe_account_id: string | null }>(
      'SELECT stripe_api_key_enc, stripe_account_id FROM organizations WHERE id = $1',
      [orgId],
    );

    if (!org) {
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

    await query(
      'UPDATE organizations SET stripe_api_key_enc = NULL, stripe_account_id = NULL WHERE id = $1',
      [orgId],
    );

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    const response = NextResponse.redirect(`${appUrl}/onboarding`, { status: 303 });
    return clearOrgCookie(response);
  } catch (err) {
    console.error('Disconnect error:', err);
    return NextResponse.json({ error: 'Failed to disconnect. Could not clean up Stripe webhooks.' }, { status: 500 });
  }
}
