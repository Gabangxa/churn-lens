import { Polar } from '@polar-sh/sdk';

/**
 * Polar client and configuration.
 *
 * Polar bills ChurnLens itself. This is unrelated to the per-org Stripe
 * credentials in organizations.stripe_api_key_enc, which are *customers'* keys
 * used to detect *their* churn — the two must never be conflated.
 *
 * Credentials are read lazily rather than validated at boot (they are absent
 * from env.ts's REQUIRED set on purpose): billing is not wired in every
 * environment yet, and making the app refuse to start without a Polar token
 * would take down survey delivery — the part that already works — for the sake
 * of a feature nobody has bought yet.
 */

/**
 * Which Polar backend to talk to. Sandbox is a genuinely separate world with
 * its own products, customers and tokens, so a test deployment pointed at
 * production would bill real cards.
 */
export function polarServer(): 'sandbox' | 'production' {
  return process.env.POLAR_SERVER === 'production' ? 'production' : 'sandbox';
}

export function getPolar(): Polar {
  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('POLAR_ACCESS_TOKEN is not set — billing is not configured for this environment');
  }
  return new Polar({ accessToken, server: polarServer() });
}

export function getPolarWebhookSecret(): string {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('POLAR_WEBHOOK_SECRET is not set — cannot verify Polar webhooks');
  }
  return secret;
}
