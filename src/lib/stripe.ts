import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
  typescript: true,
});

/**
 * Verify a Stripe webhook signature and return the parsed event.
 * Throws if the signature is invalid — always call this in webhook routes.
 */
export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
