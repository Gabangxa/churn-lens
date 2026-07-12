import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { query, queryOne } from '@/lib/db';
import { encryptApiKey } from '@/lib/crypto';
import { setOrgCookie, requireOrgId } from '@/lib/auth';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';

export async function POST(req: NextRequest) {
  try {
    // Throttle org creation / Stripe webhook registration per IP.
    const rl = checkRateLimit(`onboard:${clientIp(req)}`, 8, 600_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many attempts. Please wait a minute and try again.' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
      );
    }

    const body = await req.json();
    const { apiKey, email } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
    }

    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json({ error: 'API key is required.' }, { status: 400 });
    }

    if (!apiKey.startsWith('rk_')) {
      return NextResponse.json(
        { error: 'Please provide a Stripe restricted API key (starts with rk_).' },
        { status: 400 },
      );
    }

    // Use existing org from cookie, or generate a new UUID server-side.
    // orgId is NEVER accepted from the request body.
    const authResult = requireOrgId(req);
    const orgId = 'orgId' in authResult ? authResult.orgId : randomUUID();

    const encrypted = encryptApiKey(apiKey);

    const existing = await queryOne<{ id: string; stripe_webhook_id: string | null }>(
      'SELECT id, stripe_webhook_id FROM organizations WHERE id = $1',
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

    if (!existing?.stripe_webhook_id) {
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

    // Upsert the founder's user row so the weekly digest can reach them.
    const existingUser = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE org_id = $1',
      [orgId],
    );
    if (existingUser) {
      await query('UPDATE users SET email = $1 WHERE org_id = $2', [email, orgId]);
    } else {
      await query(
        'INSERT INTO users (org_id, email, role) VALUES ($1, $2, $3)',
        [orgId, email, 'owner'],
      );
    }

    const response = NextResponse.json({ success: true });
    return setOrgCookie(response, orgId);
  } catch (err) {
    console.error('Onboarding connect error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
