import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { query, queryOne } from '@/lib/db';
import { encryptApiKey } from '@/lib/crypto';
import { setOrgCookie, requireOrgId } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
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
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      console.error('NEXT_PUBLIC_APP_URL is not set — cannot register Stripe webhook.');
      return NextResponse.json(
        { error: 'Server misconfiguration: app URL is not set. Contact support.' },
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
        return NextResponse.json(
          { error: `Failed to register Stripe webhook: ${message}. Check that your key has webhooks:write permission.` },
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

    const response = NextResponse.json({ success: true });
    return setOrgCookie(response, orgId);
  } catch (err) {
    console.error('Onboarding connect error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
