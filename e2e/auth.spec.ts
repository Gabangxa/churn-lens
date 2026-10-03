import { expect, test } from '@playwright/test';
import {
  closeDb,
  loginTokenUsedAt,
  queryOne,
  refuseOrgColumnWrites,
  seedLoginToken,
  seedOrg,
  uniqueEmail,
} from './helpers/db';
import { E2E_CLIENT_IP } from './env';
import { atLoginWithNext, confirmSignIn, loginAs } from './helpers/session';

const SESSION_COOKIE = 'churnlens_org_id';

/**
 * Sign-in is the whole trust boundary: the confirm page's same-origin POST to
 * /api/auth/verify is the only request in the app that ever mints a session,
 * and everything else assumes a cookie it did not issue cannot exist. These
 * specs cover the ways that can go wrong end to end — a link that works, one
 * that signs someone in merely by being opened, one that is replayed, one
 * that has expired, and a page that should have demanded one and didn't.
 */
test.describe('authentication', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  /**
   * The ONE real form submission against /api/auth/request in the suite. That
   * route is rate-limited to 5 per IP per 10 minutes in the server's memory,
   * and the server is reused between local runs — every other spec seeds its
   * token straight into the database instead (see loginAs).
   */
  test('signing up through the form lowercases the email and carries the plan', async ({ page }) => {
    // Case only. The whitespace half of normalization cannot be tested here:
    // an input[type=email] strips leading/trailing whitespace itself, so the
    // server never sees it. csrf.spec.ts asserts trimming at the API level,
    // where a client can actually send it.
    const localPart = `Mixed.Case.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const typedEmail = `${localPart}@Example.test`;
    const normalizedEmail = typedEmail.toLowerCase();

    await page.goto('/login?plan=growth');
    await page.getByLabel('Your email address').fill(typedEmail);
    await page.getByRole('button', { name: 'Send login link' }).click();

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    // The account the form created. Asserted from the database rather than
    // from the response, because the route answers { ok: true } either way —
    // that is the enumeration-safety guarantee, and it means the UI cannot
    // tell you whether a signup actually happened.
    const user = await queryOne<{ org_id: string; email: string }>(
      'SELECT org_id, email FROM users WHERE lower(email) = $1',
      [normalizedEmail],
    );
    expect(user).not.toBeNull();
    expect(user!.email).toBe(normalizedEmail);

    const org = await queryOne<{ id: string }>('SELECT id FROM organizations WHERE id = $1', [
      user!.org_id,
    ]);
    expect(org).not.toBeNull();

    const token = await queryOne<{ redirect_to: string | null; used_at: string | null }>(
      'SELECT redirect_to, used_at FROM login_tokens WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1',
      [user!.org_id],
    );
    expect(token).not.toBeNull();
    expect(token!.redirect_to).toBe('/onboarding?plan=growth');
    expect(token!.used_at).toBeNull();

    // Requesting a link must never be a login: the session is minted only
    // once the link in the inbox is actually clicked.
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  test('a magic link for an org with no Stripe key lands on onboarding, not its redirect_to', async ({ page }) => {
    const email = uniqueEmail('keyless');
    const { orgId } = await seedOrg({ email });

    const { rawToken } = await loginAs(page, { orgId, email, redirectTo: '/settings' });

    // redirect_to said /settings; the org has no key, so onboarding wins.
    await page.waitForURL((url) => url.pathname === '/onboarding');

    const cookie = (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);

    const org = await queryOne<{ last_login_at: string | null }>(
      'SELECT last_login_at FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(org!.last_login_at).not.toBeNull();

    const token = await queryOne<{ used_at: string | null }>(
      'SELECT used_at FROM login_tokens WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orgId],
    );
    expect(token!.used_at).not.toBeNull();
    expect(rawToken.length).toBeGreaterThan(20);
  });

  test('opening a magic link signs nobody in until the founder confirms on our own page', async ({ page }) => {
    const email = uniqueEmail('confirm');
    const { orgId } = await seedOrg({ email });
    const { rawToken, verifyPath } = await seedLoginToken(orgId, email);

    // What a mail scanner, a link prefetcher or the founder's click does.
    await page.goto(verifyPath);
    await page.waitForURL((url) => url.pathname === '/login/confirm');

    // The page names the address the link was sent to...
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Sign in to ChurnLens as ${email}`);
    // ...and so far nothing has happened: no session, and the link is unspent.
    expect((await page.context().cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(await loginTokenUsedAt(rawToken)).toBeNull();

    await confirmSignIn(page);
    await page.waitForURL((url) => url.pathname === '/onboarding');

    expect((await page.context().cookies()).find((c) => c.name === SESSION_COOKIE)).toBeDefined();
    expect(await loginTokenUsedAt(rawToken)).not.toBeNull();
  });

  test("an attacker's own link opened in a signed-in browser does not switch its session", async ({ page }) => {
    // Login CSRF: the attacker requests a link for an address they own and
    // gets a victim's browser to open it. Before the confirm step, that alone
    // signed the victim into the attacker's org.
    const victimEmail = uniqueEmail('victim');
    const { orgId: victimOrg } = await seedOrg({ email: victimEmail });
    await loginAs(page, { orgId: victimOrg, email: victimEmail });
    await page.waitForURL((url) => url.pathname === '/onboarding');
    const victimCookie = (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(victimCookie).toBeDefined();

    const attackerEmail = uniqueEmail('attacker');
    const { orgId: attackerOrg } = await seedOrg({ email: attackerEmail });
    const { rawToken, verifyPath } = await seedLoginToken(attackerOrg, attackerEmail);

    await page.goto(verifyPath);
    await page.waitForURL((url) => url.pathname === '/login/confirm');

    // The victim is shown whose account this is, and is still signed in as themselves.
    await expect(page.getByText(attackerEmail)).toBeVisible();

    // Nor can the attacker's page press the button for them: a cross-site
    // form POST of the token, sent from this browser with its cookies, is
    // refused before the token is looked at.
    const forged = await page.request.post('/api/auth/verify', {
      headers: { origin: 'https://evil.example' },
      form: { token: rawToken },
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(403);

    const cookieAfter = (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookieAfter?.value).toBe(victimCookie!.value);
    expect(await loginTokenUsedAt(rawToken)).toBeNull();
  });

  test('replaying a consumed magic link mints no second session', async ({ page, browser, baseURL }) => {
    const email = uniqueEmail('replay');
    const { orgId } = await seedOrg({ email });

    const { verifyPath } = await loginAs(page, { orgId, email });
    await page.waitForURL((url) => url.pathname === '/onboarding');

    // A second browser, so "no cookie was set" is a fact about this request
    // rather than about a context that already holds one from the first click.
    // A context created straight off `browser` does not inherit the config's
    // `use` block, so the run's server and rate-limit identity are restated.
    const replayContext = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': E2E_CLIENT_IP },
    });
    const replayPage = await replayContext.newPage();
    // A used link does not even reach the confirm button: the confirm page
    // sends it straight to the error.
    await replayPage.goto(verifyPath);
    await replayPage.waitForURL(
      (url) => url.pathname === '/login' && url.searchParams.get('error') === 'expired',
    );

    const cookies = await replayContext.cookies();
    expect(cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    await replayContext.close();
  });

  test('an expired magic link is refused', async ({ page }) => {
    const email = uniqueEmail('expired');
    const { orgId } = await seedOrg({ email });
    const { verifyPath } = await seedLoginToken(orgId, email, { expiresInMs: -60_000 });

    await page.goto(verifyPath);
    await page.waitForURL(
      (url) => url.pathname === '/login' && url.searchParams.get('error') === 'expired',
    );

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  test('signed-out visitors are sent to login with their destination attached', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL(atLoginWithNext('/dashboard'));

    await page.goto('/onboarding?plan=growth');
    await page.waitForURL(atLoginWithNext('/onboarding'));
    expect(decodeURIComponent(new URL(page.url()).search)).toContain('plan=growth');

    // /settings gates client-side (its data fetch 401s and the page pushes),
    // so this redirect happens after load rather than in the response.
    await page.goto('/settings');
    await page.waitForURL(atLoginWithNext('/settings'));
  });

  test('a magic link for a connected org honours redirect_to', async ({ page }) => {
    const email = uniqueEmail('connected');
    const { orgId } = await seedOrg({ email, withStripeKey: true, withStripeWebhook: true });

    await loginAs(page, { orgId, email, redirectTo: '/settings' });

    await page.waitForURL((url) => url.pathname === '/settings');
  });

  test('a magic link for an org with a key but no registered webhook lands on onboarding', async ({ page }) => {
    // Connect saved the key, then failed to register the webhook: Stripe will
    // never tell us about a cancellation, so no survey goes out. The dashboard
    // it asked for cannot fix that; onboarding can.
    const email = uniqueEmail('halfconnected');
    const { orgId } = await seedOrg({ email, withStripeKey: true });

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });

    await page.waitForURL((url) => url.pathname === '/onboarding');
  });

  test('a logout that cannot end the other devices says so on /login, and still signs this browser out', async ({ page }) => {
    // Someone logging out because a laptop went missing must not be shown the
    // landing page as if every device had been signed out — nor, because the
    // button is a native form POST, a raw JSON error page.
    const email = uniqueEmail('logoutpartial');
    const { orgId } = await seedOrg({ email, withStripeKey: true, withStripeWebhook: true });
    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    const allowWrites = await refuseOrgColumnWrites(orgId, 'sessions_valid_after');
    try {
      await page.getByRole('button', { name: 'Log out' }).click();
      await page.waitForURL(
        (url) => url.pathname === '/login' && url.searchParams.get('error') === 'logout_partial',
      );
    } finally {
      await allowWrites();
    }

    // By text, not role: Next's route announcer is a role="alert" too.
    await expect(
      page.getByText("You're signed out of this browser, but not on your other devices"),
    ).toBeVisible();
    expect((await page.context().cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    const org = await queryOne<{ sessions_valid_after: string | null }>(
      'SELECT sessions_valid_after FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(org!.sessions_valid_after).toBeNull();
  });
});
