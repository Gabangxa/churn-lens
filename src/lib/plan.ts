/**
 * Plan values and the Polar subscription → plan mapping.
 *
 * Until now nothing in the app ever wrote organizations.plan: the column
 * defaulted to 'free' and stayed there, which silently made every paid feature
 * unreachable — /api/themes only selects plan IN ('starter','growth'), so the
 * weekly clustering run processed zero orgs. This module is the single place
 * that decides what a plan is and when a subscription earns one.
 */

export const PLANS = ['free', 'starter', 'growth'] as const;
export type Plan = (typeof PLANS)[number];

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

/**
 * Subscription statuses that keep a customer entitled to their paid plan.
 *
 * `past_due` is deliberately entitled. Polar retries a failed payment before
 * giving up, and revoking the moment a card bounces punishes a customer whose
 * bank declined one charge — they keep access until Polar actually ends the
 * subscription, which arrives as `revoked` with a terminal status below.
 *
 * `trialing` is entitled because a trial that cannot use the product is not a
 * trial. Polar's docs are explicit that a subscription can be created before
 * its first payment settles, which is why `incomplete` is absent from both
 * lists: it has never been paid, so there is nothing to grant and nothing to
 * revoke.
 */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** Statuses where access has genuinely ended and the org drops to free. */
const REVOKED_STATUSES = new Set([
  'canceled',
  'unpaid',
  'incomplete_expired',
  'paused',
]);

export type Entitlement = 'grant' | 'revoke' | 'ignore';

/**
 * Decide what a subscription status means for entitlement.
 *
 * Driven by the subscription's *status*, not by which webhook carried it. Polar
 * fires `subscription.canceled` when the customer requests cancellation, while
 * the subscription stays active until the period ends — reacting to that event
 * type would cut off customers who have already paid for the rest of the month.
 * The status field tells the truth in every case; the event type does not.
 */
export function entitlementForStatus(status: string): Entitlement {
  if (ENTITLED_STATUSES.has(status)) return 'grant';
  if (REVOKED_STATUSES.has(status)) return 'revoke';
  return 'ignore';
}

/**
 * Map a Polar product to the plan it grants.
 *
 * Product ids live in env rather than the database because they differ between
 * Polar's sandbox and production organizations, and the test environment must
 * be able to point at sandbox products without a migration. Returns null for an
 * unrecognized product so the caller can refuse to guess — granting the wrong
 * tier is worse than granting nothing.
 */
export function planForProduct(productId: string): Plan | null {
  const starter = process.env.POLAR_PRODUCT_STARTER;
  const growth = process.env.POLAR_PRODUCT_GROWTH;

  if (starter && productId === starter) return 'starter';
  if (growth && productId === growth) return 'growth';
  return null;
}
