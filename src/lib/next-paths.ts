/**
 * The only redirect targets a magic link (or a redirect built from one) is
 * allowed to carry, and the one place that allow-list is defined. Anything
 * else — an absolute URL, a protocol-relative "//evil.com", an unlisted path —
 * is an open-redirect attempt.
 *
 * Dependency-free on purpose: this is imported from a server route
 * (src/app/api/auth/request/route.ts), from the same route's sibling
 * (src/app/api/auth/verify/route.ts, which re-validates on read), and from a
 * client component (src/app/login/page.tsx). Pulling in next/server, the db
 * layer, or anything else with server-only side effects here would drag that
 * into the client bundle.
 */
export const ALLOWED_NEXT_PATHS = new Set([
  '/dashboard',
  '/settings',
  '/onboarding',
  '/onboarding?plan=starter',
  '/onboarding?plan=growth',
]);

/**
 * Returns `next` unchanged if it is exactly one of the allow-listed paths,
 * otherwise null. Silent, not throwing: a forged or malformed value should
 * degrade to "no redirect requested", never fail the caller's whole request.
 */
export function sanitizeNext(next: unknown): string | null {
  if (typeof next !== 'string') return null;
  return ALLOWED_NEXT_PATHS.has(next) ? next : null;
}
