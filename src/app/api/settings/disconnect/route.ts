import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { decryptApiKey } from '@/lib/crypto';
import { requireOrgId, clearOrgCookie } from '@/lib/auth';
import Stripe from 'stripe';

export async function DELETE(req: NextRequest) {
  const auth = requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  const org = await queryOne<{
    stripe_api_key_enc: string | null;
    stripe_webhook_id: string | null;
  }>(
    'SELECT stripe_api_key_enc, stripe_webhook_id FROM organizations WHERE id = $1',
    [orgId],
  );

  if (!org) {
    return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
  }

  // Delete only the webhook endpoint ChurnLens registered — never touch others.
  if (org.stripe_api_key_enc && org.stripe_webhook_id) {
    try {
      const apiKey = decryptApiKey(org.stripe_api_key_enc);
      const stripeClient = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });
      await stripeClient.webhookEndpoints.del(org.stripe_webhook_id);
    } catch (err) {
      // Log but don't block disconnect — the org record must be cleared regardless.
      console.error('Failed to delete Stripe webhook endpoint:', err);
    }
  }

  await query(
    `UPDATE organizations
     SET stripe_api_key_enc = NULL,
         stripe_account_id = NULL,
         stripe_webhook_id = NULL,
         stripe_webhook_secret_enc = NULL
     WHERE id = $1`,
    [orgId],
  );

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
  const response = NextResponse.redirect(`${appUrl}/onboarding`, { status: 303 });
  return clearOrgCookie(response);
}
