/**
 * The set of plans an organization can be on.
 *
 * Until now nothing in the app ever wrote organizations.plan: the column
 * defaulted to 'free' and stayed there, which silently made every paid feature
 * unreachable — /api/themes only selects plan IN ('starter','growth'), so the
 * weekly clustering run processed zero orgs. This module is the single place
 * that decides what a valid plan is.
 */

export const PLANS = ['free', 'starter', 'growth'] as const;
export type Plan = (typeof PLANS)[number];

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}
