import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { query, queryOne } from '@/lib/db';
import { encryptApiKey } from '@/lib/crypto';
import { assertSameOrigin, requireOrgId, clearOrgCookie } from '@/lib/auth';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';

/**
 * Attach (or replace) the signed-in org's Stripe restricted key and register
 * ChurnLens's webhook on the customer's Stripe account.
 *
 * A session is required — this route no longer creates orgs or users, and no
 * longer accepts an email. Both of those used to be trusted from the request
 * body with nothing proving the caller owned that address; that was the
 * account-takeover hole this route was rewritten to close. Signup now happens
 * only in /api/auth/request, and a session is minted only in /api/auth/verify.
 */
export async function POST(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  try {
    // Throttle webhook registration per IP, independent of the per-org session.
    const rl = checkRateLimit(`onboard:${clientIp(req)}`, 8, 600_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many attempts. Please wait a minute and try again.' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
      );
    }

    const authResult = requireOrgId(req);
    if ('error' in authResult) return authResult.error;
    const { orgId } = authResult;

    const body = await req.json();
    const { apiKey } = body;

    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json({ error: 'API key is required.' }, { status: 400 });
    }

    if (!apiKey.startsWith('rk_')) {
      return NextResponse.json(
        { error: 'Please provide a Stripe restricted API key (starts with rk_).' },
        { status: 400 },
      );
    }

    const existing = await queryOne<{ id: string; stripe_webhook_id: string | null }>(
      'SELECT id, stripe_webhook_id FROM organizations WHERE id = $1',
      [orgId],
    );

    if (!existing) {
      // The cookie's signature verified, but the org row it names is gone
      // (deleted out from under an old session, or a session from a
      // different environment/database). There is nothing to attach a key
      // to, and creating a fresh org here would silently reintroduce the
      // "connect without proving who you are" hole this route was rewritten
      // to close — so this forces a real re-login instead.
      const response = NextResponse.json(
        { error: 'Session is no longer valid. Please log in again.' },
        { status: 401 },
      );
      return clearOrgCookie(response);
    }

    const encrypted = encryptApiKey(apiKey);
    await query('UPDATE organizations SET stripe_api_key_enc = $1 WHERE id = $2', [encrypted, orgId]);

    // Register ChurnLens webhook on the customer's Stripe account (only if not already done).
    // Stripe rejects webhook URLs without an explicit https scheme, so fail fast here
    // instead of surfacing a confusing Stripe error to the user.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl || !appUrl.startsWith('https://')) {
      console.error(
        `NEXT_PUBLIC_APP_URL is ${appUrl ? `"${appUrl}" (must start with https://)` : 'not set'} — cannot register Stripe webhook.`,
      );
      return NextResponse.json(
        { error: 'Server misconfiguration: app URL is missing or not https. Contact support.' },
        { status: 500 },
      );
    }

    if (!existing.stripe_webhook_id) {
      let webhookEndpoint: Stripe.WebhookEndpoint;
      try {
        const customerStripe = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });
        webhookEndpoint = await customerStripe.webhookEndpoints.create({
          url: `${appUrl}/api/webhooks/stripe/${orgId}`,
          enabled_events: ['customer.subscription.deleted'],
          description: 'ChurnLens exit survey trigger',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('Stripe webhook registration failed:', err);
        // Only blame the key when Stripe actually reported an auth/permission
        // problem — other failures (bad URL, network) are not the user's fault.
        const isKeyProblem =
          err instanceof Stripe.errors.StripeAuthenticationError ||
          err instanceof Stripe.errors.StripePermissionError;
        const hint = isKeyProblem
          ? ' Check that your key is valid and has Webhook Endpoints write permission.'
          : '';
        return NextResponse.json(
          { error: `Failed to register Stripe webhook: ${message}.${hint}` },
          { status: 422 },
        );
      }

      await query(
        `UPDATE organizations
         SET stripe_webhook_id = $1, stripe_webhook_secret_enc = $2
         WHERE id = $3`,
        [webhookEndpoint.id, encryptApiKey(webhookEndpoint.secret!), orgId],
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Onboarding connect error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
