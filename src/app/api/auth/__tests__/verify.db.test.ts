import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { renderToStaticMarkup } from 'react-dom/server';
import { getURLFromRedirectError, isRedirectError } from 'next/dist/client/components/redirect';
import { assertThrowawayDatabase } from '../../../../../e2e/helpers/throwaway-db';

/**
 * Magic-link sign-in against a real PostgreSQL: the emailed link (GET
 * /api/auth/verify), the confirm page it forwards to (/login/confirm), and the
 * same-origin POST that is the only thing allowed to use the link up and mint
 * a session.
 *
 * The split exists because a GET that signs you in is a login-CSRF primitive:
 * an attacker requests a link for their OWN address and navigates a victim's
 * browser to it, and the victim is silently working inside the attacker's org
 * (and may paste their Stripe key into it). It also let mail scanners burn
 * single-use links before the founder ever clicked them. Everything that
 * matters here is a database fact — was the token used, which org did the
 * cookie land on — so it is asserted against real rows rather than mocks.
 *
 * Same contract as the other *.db.test.ts suites: skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database. It TRUNCATEs
 * organizations (cascading to login_tokens) between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const dbState = vi.hoisted(() => ({ pool: null as Pool | null }));
function pool(): Pool {
  if (!dbState.pool) throw new Error('test pool not initialised');
  return dbState.pool;
}

vi.mock('@/lib/db', () => ({
  query: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows,
  execute: async (text: string, params?: unknown[]) =>
    (await pool().query(text, params)).rowCount ?? 0,
  queryOne: async (text: string, params?: unknown[]) =>
    (await pool().query(text, params)).rows[0] ?? null,
}));

import { GET, POST } from '../verify/route';
import ConfirmSignInPage from '@/app/login/confirm/page';
import { requireOrgId, setOrgCookie } from '@/lib/auth';

const APP_URL = 'https://app.churnlens.com';
const COOKIE_NAME = 'churnlens_org_id';
const FOUNDER_EMAIL = 'founder@example.com';

interface SeedOrgOptions {
  /** organizations.stripe_api_key_enc set (opaque; nothing here decrypts it). */
  key?: boolean;
  /** organizations.stripe_webhook_id set — connect finished registering the webhook. */
  webhook?: boolean;
}

async function seedOrg({ key = false, webhook = false }: SeedOrgOptions = {}): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations (name, stripe_api_key_enc, stripe_webhook_id)
     VALUES ('Org', $1, $2) RETURNING id`,
    [key ? 'enc' : null, webhook ? 'we_test' : null],
  );
  return rows[0].id;
}

/** A magic-link token as /api/auth/request stores it (hash only); returns the raw token from the email. */
async function seedToken(
  orgId: string,
  { email = FOUNDER_EMAIL, redirectTo = null as string | null, expiresIn = '15 minutes' } = {},
): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  await pool().query(
    `INSERT INTO login_tokens (token_hash, org_id, email, expires_at, redirect_to)
     VALUES ($1, $2, $3, now() + $4::interval, $5)`,
    [createHash('sha256').update(rawToken).digest('hex'), orgId, email, expiresIn, redirectTo],
  );
  return rawToken;
}

async function tokenUsedAt(rawToken: string): Promise<Date | null> {
  const { rows } = await pool().query<{ used_at: Date | null }>(
    'SELECT used_at FROM login_tokens WHERE token_hash = $1',
    [createHash('sha256').update(rawToken).digest('hex')],
  );
  if (rows.length === 0) throw new Error('token row is gone');
  return rows[0].used_at;
}

function sessionCookieFor(orgId: string): string {
  const carrier = setOrgCookie(NextResponse.next(), orgId);
  return carrier.cookies.get(COOKIE_NAME)!.value;
}

/** What a browser does when the founder clicks the link in the email (a cross-site top-level navigation). */
function openEmailLink(rawToken: string | null, headers: Record<string, string> = {}) {
  const url = rawToken === null
    ? 'http://localhost/api/auth/verify'
    : `http://localhost/api/auth/verify?token=${encodeURIComponent(rawToken)}`;
  return GET(new NextRequest(url, { headers: { 'sec-fetch-site': 'cross-site', ...headers } }));
}

type ConfirmPageResult = { html: string } | { redirectedTo: string };

/** Render /login/confirm the way Next does for `?token=...`, capturing a redirect() instead of HTML. */
async function renderConfirmPage(token: string | string[] | undefined): Promise<ConfirmPageResult> {
  try {
    return { html: renderToStaticMarkup(await ConfirmSignInPage({ searchParams: { token } })) };
  } catch (err) {
    if (isRedirectError(err)) return { redirectedTo: getURLFromRedirectError(err) };
    throw err;
  }
}

/**
 * Press "Sign in" on the confirm page: a native form POST. Same-origin by
 * default; pass `origin` / `sec-fetch-site` to be a foreign page instead.
 */
function submitConfirm(
  rawToken: string | null,
  { headers = { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' } as Record<string, string>, cookie = '' } = {},
) {
  const body = new URLSearchParams();
  if (rawToken !== null) body.set('token', rawToken);
  return POST(
    new NextRequest('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { ...headers, ...(cookie ? { cookie: `${COOKIE_NAME}=${cookie}` } : {}) },
      body,
    }),
  );
}

/** The org a session cookie value authenticates as on the next request, through the real gate. */
async function orgOfCookie(cookie: string | undefined): Promise<string | null> {
  if (!cookie) return null;
  const auth = await requireOrgId(
    new NextRequest('http://localhost/api/settings/status', {
      headers: { cookie: `${COOKIE_NAME}=${cookie}` },
    }),
  );
  return 'orgId' in auth ? auth.orgId : null;
}

/** The org the session a response just set authenticates as, or null if it set none. */
function sessionOrgOf(res: NextResponse): Promise<string | null> {
  return orgOfCookie(res.cookies.get(COOKIE_NAME)?.value);
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('magic-link sign-in against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'sessions_valid_after'`,
    );
    if (rows.length === 0) {
      throw new Error(
        'TEST_DATABASE_URL is not migrated — run `node scripts/migrate.js` against it first.',
      );
    }
  });

  afterAll(async () => {
    await dbState.pool?.end();
    dbState.pool = null;
  });

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'e'.repeat(64));
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    await pool().query('TRUNCATE organizations CASCADE');
  });

  // ─── The emailed link ───────────────────────────────────────────────────────

  describe('opening the emailed link (GET)', () => {
    it('forwards to the confirm page without using the link up or setting a cookie', async () => {
      const orgId = await seedOrg({ key: true, webhook: true });
      const token = await seedToken(orgId);

      const res = await openEmailLink(token);

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(
        `${APP_URL}/login/confirm?token=${encodeURIComponent(token)}`,
      );
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await tokenUsedAt(token)).toBeNull();
    });

    it('can be opened any number of times (mail scanners, prefetchers) and the founder can still sign in', async () => {
      const orgId = await seedOrg({ key: true, webhook: true });
      const token = await seedToken(orgId);

      await openEmailLink(token);
      await openEmailLink(token);
      await renderConfirmPage(token);

      const res = await submitConfirm(token);
      expect(await sessionOrgOf(res)).toBe(orgId);
    });

    it('sends a link with no token to the /login error, as before', async () => {
      const res = await openEmailLink(null);

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  // ─── The confirm page ───────────────────────────────────────────────────────

  describe('the confirm page', () => {
    it('names the address the link was sent to and posts the token back to our own origin', async () => {
      const orgId = await seedOrg();
      const token = await seedToken(orgId);

      const result = await renderConfirmPage(token);

      if (!('html' in result)) throw new Error(`redirected to ${result.redirectedTo}`);
      expect(result.html).toContain(FOUNDER_EMAIL);
      const form = result.html.match(/<form[^>]*>/)?.[0] ?? '';
      expect(form).toContain('action="/api/auth/verify"');
      expect(form).toMatch(/method="post"/i);
      expect(result.html.match(/name="token"[^>]*value="([^"]*)"/)?.[1]).toBe(token);
      // Looking is not signing in.
      expect(await tokenUsedAt(token)).toBeNull();
    });

    it.each([
      ['already used', { used: true, expiresIn: '15 minutes' }],
      ['expired', { used: false, expiresIn: '-1 minute' }],
    ])('sends an %s link to the /login error without showing whose it was', async (_label, opts) => {
      const orgId = await seedOrg();
      const token = await seedToken(orgId, { email: 'leaky@example.com', expiresIn: opts.expiresIn });
      if (opts.used) {
        await pool().query('UPDATE login_tokens SET used_at = now() WHERE org_id = $1', [orgId]);
      }

      expect(await renderConfirmPage(token)).toEqual({ redirectedTo: '/login?error=expired' });
    });

    it.each([
      ['unknown', 'not-a-token-anyone-was-sent'],
      ['missing', undefined],
      ['empty', ''],
    ])('sends an %s token to the /login error', async (_label, token) => {
      expect(await renderConfirmPage(token)).toEqual({ redirectedTo: '/login?error=expired' });
    });
  });

  // ─── Confirming ─────────────────────────────────────────────────────────────

  describe('confirming (POST)', () => {
    it('signs this browser in to the token’s org, uses the token up and records the sign-in', async () => {
      const orgId = await seedOrg({ key: true, webhook: true });
      const token = await seedToken(orgId);

      const res = await submitConfirm(token);

      expect(res.status).toBe(303);
      expect(await sessionOrgOf(res)).toBe(orgId);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=lax');
      expect(await tokenUsedAt(token)).not.toBeNull();
      const { rows } = await pool().query('SELECT last_login_at FROM organizations WHERE id = $1', [orgId]);
      expect(rows[0].last_login_at).not.toBeNull();
    });

    it('works once: confirming the same link again fails and mints nothing', async () => {
      const orgId = await seedOrg({ key: true, webhook: true });
      const token = await seedToken(orgId);
      await submitConfirm(token);

      const replay = await submitConfirm(token);

      expect(replay.status).toBe(303);
      expect(replay.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
      expect(replay.headers.get('set-cookie')).toBeNull();
    });

    it('lets exactly one of two simultaneous confirmations through (a double-click)', async () => {
      const orgId = await seedOrg({ key: true, webhook: true });
      const token = await seedToken(orgId);

      const results = await Promise.all([submitConfirm(token), submitConfirm(token)]);

      const signedIn = results.filter((res) => res.headers.get('set-cookie') !== null);
      expect(signedIn).toHaveLength(1);
    });

    it('refuses a link that expired while the confirm page sat open', async () => {
      const orgId = await seedOrg({ key: true, webhook: true });
      const token = await seedToken(orgId, { expiresIn: '-1 second' });

      const res = await submitConfirm(token);

      expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it.each([
      ['an unknown token', 'never-issued'],
      ['no token at all', null],
    ])('answers %s with the /login error', async (_label, token) => {
      const res = await submitConfirm(token);

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('answers a body that is not a form with the /login error, not a 500', async () => {
      const res = await POST(
        new NextRequest('http://localhost/api/auth/verify', {
          method: 'POST',
          headers: { origin: 'http://localhost', 'content-type': 'application/json' },
          body: '{"token":',
        }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
    });

    it.each([
      ['a foreign Origin', { origin: 'https://evil.example' }],
      ['Sec-Fetch-Site: cross-site and no Origin', { 'sec-fetch-site': 'cross-site' }],
    ])('refuses a POST carrying %s, leaving the link usable', async (_label, headers) => {
      const orgId = await seedOrg({ key: true, webhook: true });
      const token = await seedToken(orgId);

      const res = await submitConfirm(token, { headers });

      expect(res.status).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await tokenUsedAt(token)).toBeNull();
    });
  });

  // ─── The attack this split closes ───────────────────────────────────────────

  describe('login CSRF: an attacker’s own link opened in a signed-in victim’s browser', () => {
    it('cannot switch the victim’s session without a same-origin confirmation', async () => {
      const victimOrg = await seedOrg({ key: true, webhook: true });
      const victimCookie = sessionCookieFor(victimOrg);
      // The attacker signs up with their own address and keeps the link.
      const attackerOrg = await seedOrg();
      const attackerToken = await seedToken(attackerOrg, { email: 'attacker@evil.example' });

      // 1. A link, an <img>, a redirect or a top-level navigation to the URL.
      const opened = await openEmailLink(attackerToken, {
        cookie: `${COOKIE_NAME}=${victimCookie}`,
      });
      expect(opened.headers.get('set-cookie')).toBeNull();

      // 2. The page it lands on shows whose account this is, and does nothing.
      const page = await renderConfirmPage(attackerToken);
      expect('html' in page && page.html).toContain('attacker@evil.example');

      // 3. An auto-submitting form on the attacker's page.
      const forged = await submitConfirm(attackerToken, {
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        cookie: victimCookie,
      });
      expect(forged.status).toBe(403);
      expect(forged.headers.get('set-cookie')).toBeNull();

      // The victim is still in their own org, and the attacker's link is unused.
      expect(await orgOfCookie(victimCookie)).toBe(victimOrg);
      expect(await tokenUsedAt(attackerToken)).toBeNull();
    });
  });

  // ─── Where a confirmed sign-in lands ────────────────────────────────────────

  describe('where a confirmed sign-in lands', () => {
    async function landingFor(org: SeedOrgOptions, redirectTo: string | null): Promise<string | null> {
      const orgId = await seedOrg(org);
      const res = await submitConfirm(await seedToken(orgId, { redirectTo }));
      expect(res.headers.get('set-cookie')).toContain(`${COOKIE_NAME}=${orgId}.`);
      return res.headers.get('location');
    }

    const keyless = {};
    const keyNoWebhook = { key: true };
    const connected = { key: true, webhook: true };

    it.each([
      ['a keyless org with no redirect_to', keyless, null, '/onboarding'],
      ['a keyless org whose redirect_to is /settings', keyless, '/settings', '/onboarding'],
      ['a keyless org whose redirect_to is /dashboard', keyless, '/dashboard', '/onboarding'],
      ['a keyless org carrying a plan', keyless, '/onboarding?plan=growth', '/onboarding?plan=growth'],
      // A stored key with no webhook is a connect that failed half-way: Stripe
      // will never call us, so no survey goes out. Onboarding is where the
      // founder can finish it.
      ['a key-but-no-webhook org with no redirect_to', keyNoWebhook, null, '/onboarding'],
      ['a key-but-no-webhook org whose redirect_to is /dashboard', keyNoWebhook, '/dashboard', '/onboarding'],
      ['a key-but-no-webhook org whose redirect_to is /settings', keyNoWebhook, '/settings', '/onboarding'],
      ['a key-but-no-webhook org carrying a plan', keyNoWebhook, '/onboarding?plan=starter', '/onboarding?plan=starter'],
      ['a connected org with no redirect_to', connected, null, '/dashboard'],
      ['a connected org whose redirect_to is /settings', connected, '/settings', '/settings'],
    ])('sends %s to its destination', async (_label, org, redirectTo, expected) => {
      expect(await landingFor(org, redirectTo)).toBe(`${APP_URL}${expected}`);
    });

    // redirect_to is re-validated on the way out rather than trusted as stored:
    // /api/auth/request allow-lists it on the way in, but a row this route
    // trusted blindly would be one bad migration, admin query, or future writer
    // away from an open redirect on the one route that hands out a session.
    it.each([
      ['a connected org', connected, 'https://evil.example/', '/dashboard'],
      ['a keyless org', keyless, '//evil.example', '/onboarding'],
    ])('ignores an off-allow-list redirect_to stored for %s', async (_label, org, redirectTo, expected) => {
      expect(await landingFor(org, redirectTo)).toBe(`${APP_URL}${expected}`);
    });
  });
});
