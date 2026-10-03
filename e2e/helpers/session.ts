import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { E2E_CRON_SECRET } from '../env';
import { seedLoginToken } from './db';

export interface LoginAsOptions {
  orgId: string;
  email: string;
  /** login_tokens.redirect_to — where verify sends the browser afterwards. */
  redirectTo?: string;
}

/**
 * Sign a browser in the way the app actually does it: mint a magic-link token
 * in the database, open the link, and press "Sign in" on the confirm page it
 * lands on. There is no other door — the confirm page's POST to
 * /api/auth/verify is the only request that ever sets a session cookie — so
 * this is the real flow minus the emailed round trip, not a fixture that
 * fabricates a session.
 *
 * Seeded rather than requested through /api/auth/request because that route
 * is rate-limited to 5 per IP per 10 minutes in the server's memory; a suite
 * that logged in for real in every spec would throttle itself.
 *
 * Resolves once the confirmation has been answered (the browser has left the
 * confirm page); callers wait for the destination they expect.
 */
export async function loginAs(
  page: Page,
  { orgId, email, redirectTo }: LoginAsOptions,
): Promise<{ rawToken: string; verifyPath: string }> {
  const seeded = await seedLoginToken(orgId, email, { redirectTo });
  await page.goto(seeded.verifyPath);
  await confirmSignIn(page);
  return seeded;
}

/**
 * Press "Sign in" on /login/confirm and wait until the browser has left it.
 * Leaving it is what proves the POST was answered: success redirects to the
 * destination, failure to /login?error=expired.
 */
export async function confirmSignIn(page: Page): Promise<void> {
  await page.waitForURL((url) => url.pathname === '/login/confirm');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname !== '/login/confirm');
}

/**
 * Predicate for page.waitForURL: "the app bounced us to the login page,
 * asking to come back to `next` afterwards". A predicate rather than a glob
 * because the `next` value contains `?`, `/` and `&`, which a URL glob would
 * either treat as wildcards or fail to match once the browser re-encodes them.
 */
export function atLoginWithNext(next: string): (url: URL) => boolean {
  return (url: URL) =>
    url.pathname === '/login' && decodeURIComponent(url.search).includes(`next=${next}`);
}

/**
 * POST a cron endpoint with the bearer token it expects. Pass `secret` to
 * exercise the rejection path.
 */
export function cronRequest(
  request: APIRequestContext,
  path: string,
  options: { secret?: string } = {},
): Promise<APIResponse> {
  return request.post(path, {
    headers: { authorization: `Bearer ${options.secret ?? E2E_CRON_SECRET}` },
  });
}
