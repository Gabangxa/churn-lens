import { expect, test } from '@playwright/test';
import { closeDb, queryOne, uniqueEmail } from './helpers/db';

const EVIL_ORIGIN = 'https://evil.example';

/**
 * assertSameOrigin (src/lib/auth.ts) is what stops a foreign page from riding
 * a founder's session or minting login links against a victim's inbox. Its
 * unit tests call it directly with hand-built headers; these prove it is
 * actually wired in front of the routes that need it, on a production build
 * where NEXT_PUBLIC_APP_URL — not "whatever origin asked" — is the allow-list.
 */
test.describe('cross-site request rejection', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test('no page can be framed, the sign-in confirmation above all', async ({ request }) => {
    // /login/confirm's one button spends a magic link; framed invisibly on
    // another site it could be clickjacked. next.config.js refuses framing
    // everywhere, so the login page (which renders for anyone) shows it.
    const res = await request.get('/login');

    expect(res.status()).toBe(200);
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('connecting Stripe without a session is unauthorized', async ({ request }) => {
    const res = await request.post('/api/onboarding/connect', {
      data: { apiKey: 'rk_live_whatever' },
    });

    expect(res.status()).toBe(401);
  });

  test('a foreign Origin is rejected on every state-changing route', async ({ request }) => {
    const connect = await request.post('/api/onboarding/connect', {
      headers: { origin: EVIL_ORIGIN },
      data: { apiKey: 'rk_live_whatever' },
    });
    expect(connect.status()).toBe(403);

    const login = await request.post('/api/auth/request', {
      headers: { origin: EVIL_ORIGIN },
      data: { email: 'victim@e2e.test' },
    });
    expect(login.status()).toBe(403);

    // The magic-link confirmation — the one request that mints a session. A
    // foreign page submitting it is login CSRF; auth.spec.ts covers it with a
    // real token in a signed-in browser.
    const confirm = await request.post('/api/auth/verify', {
      headers: { origin: EVIL_ORIGIN },
      form: { token: 'not-a-real-token' },
      maxRedirects: 0,
    });
    expect(confirm.status()).toBe(403);

    // A GET, but it starts a checkout against the signed-in org, so it is
    // state-changing in every way that matters.
    const checkout = await request.get('/api/billing/checkout?plan=starter', {
      headers: { origin: EVIL_ORIGIN },
    });
    expect(checkout.status()).toBe(403);
  });

  test('sec-fetch-site: cross-site is rejected when no Origin header is sent', async ({ request }) => {
    const res = await request.post('/api/auth/request', {
      headers: { 'sec-fetch-site': 'cross-site' },
      data: { email: 'victim@e2e.test' },
    });

    expect(res.status()).toBe(403);
  });

  /**
   * The second and last real call to /api/auth/request in the suite — keep it
   * that way: 5 per IP per 10 minutes, enforced in the server's memory.
   *
   * An open-redirect attempt has to fail quietly: the response is the same
   * { ok: true } every request gets (no enumeration), so the only place the
   * rejection is observable is the stored redirect_to.
   */
  test('an off-site "next" is dropped, and the email is trimmed and lowercased', async ({ request }) => {
    // Doubles as the trimming assertion for /api/auth/request: only an API
    // client can send surrounding whitespace, since an input[type=email]
    // strips it in the browser before the form ever posts.
    const unique = uniqueEmail('trim').split('@')[0];
    const typedEmail = `  Trim.Me.${unique}@Example.test `;
    const normalizedEmail = typedEmail.trim().toLowerCase();

    const res = await request.post('/api/auth/request', {
      data: { email: typedEmail, next: '//evil.example' },
    });

    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const token = await queryOne<{ redirect_to: string | null; email: string }>(
      'SELECT redirect_to, email FROM login_tokens WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
      [normalizedEmail],
    );
    expect(token, `no login token stored for ${normalizedEmail}`).not.toBeNull();
    expect(token!.email).toBe(normalizedEmail);
    expect(token!.redirect_to).toBeNull();

    const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE email = $1', [
      normalizedEmail,
    ]);
    expect(user).not.toBeNull();
  });
});
