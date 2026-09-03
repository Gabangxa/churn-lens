import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { decryptApiKey } from '@/lib/crypto';
import { assertSameOrigin, requireOrgId } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';
import Stripe from 'stripe';

export async function DELETE(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

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

  // Disconnecting Stripe is not logging out — the session survives, unlike the
  // old behavior which cleared the cookie here. Sessions are minted only by
  // /api/auth/verify now, so there is nothing to re-derive from a login-less
  // reconnect; clearing the cookie would just force a pointless re-login.
  //
  // redirectUrl (not a hand-built template string): NextResponse.redirect
  // requires an absolute URL, and `${appUrl}/onboarding` is '/onboarding' when
  // NEXT_PUBLIC_APP_URL is unset — a relative "URL" that throws here, AFTER the
  // key has already been nulled above. redirectUrl falls back to req.url so
  // this can never throw on a misconfigured deploy.
  return NextResponse.redirect(redirectUrl('/onboarding', req), { status: 303 });
}
