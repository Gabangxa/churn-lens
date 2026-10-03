import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, createHmac, randomBytes } from 'crypto';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { assertThrowawayDatabase } from '../../../e2e/helpers/throwaway-db';

/**
 * Sessions against a real PostgreSQL.
 *
 * A session is a signed cookie, but whether it still counts is a database
 * question (does the org exist; has it signed out everywhere since). The unit
 * suite (auth.test.ts) pins the cookie itself with that lookup stubbed; this
 * one proves the lookup, end to end: a cookie minted by the real
 * /api/auth/verify, checked by the real requireOrgId/getOrgIdFromCookieStore,
 * against rows a real engine holds.
 *
 * Same contract as src/app/api/purge/__tests__/route.db.test.ts: skipped
 * unless TEST_DATABASE_URL points at a migrated throwaway database (CI
 * provisions one). It TRUNCATEs organizations between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Owned here so afterAll can close it (an open pool keeps the worker alive).
// The helpers are the whole of db.ts's query/execute/queryOne, so the code
// under test still runs its own SQL unaltered.
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

import { requireOrgId, getOrgIdFromCookieStore } from '../auth';
import { GET as verifyMagicLink } from '@/app/api/auth/verify/route';

const COOKIE_NAME = 'churnlens_org_id';
const ENCRYPTION_KEY = 'e'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedOrg(name = 'Org'): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations (name, stripe_api_key_enc) VALUES ($1, 'enc') RETURNING id`,
    [name],
  );
  return rows[0].id;
}

/**
 * Sign a device in the only way the app allows: a magic-link token in the
 * database, consumed by /api/auth/verify. `at` sets the app clock for the
 * click, which is what the session's signed issued-at records.
 */
async function signIn(orgId: string, at?: Date): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  await pool().query(
    `INSERT INTO login_tokens (token_hash, org_id, email, expires_at)
     VALUES ($1, $2, 'founder@example.com', now() + interval '15 minutes')`,
    [createHash('sha256').update(rawToken).digest('hex'), orgId],
  );
  if (at) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
  }
  try {
    const res = await verifyMagicLink(
      new NextRequest(`http://localhost/api/auth/verify?token=${rawToken}`),
    );
    const cookie = res.cookies.get(COOKIE_NAME)?.value;
    if (!cookie) throw new Error(`verify set no session cookie (status ${res.status})`);
    return cookie;
  } finally {
    if (at) vi.useRealTimers();
  }
}

function requestWith(cookie: string): NextRequest {
  return new NextRequest('http://localhost/api/settings/status', {
    headers: { cookie: `${COOKIE_NAME}=${cookie}` },
  });
}

/** Same shape as next/headers' cookies(), as server components pass it. */
function cookieStoreWith(cookie: string) {
  return { get: (name: string) => (name === COOKIE_NAME ? { value: cookie } : undefined) };
}

/** The org a cookie authenticates as, through both public entry points — they must agree. */
async function sessionOrg(cookie: string): Promise<string | null> {
  const fromRoute = await requireOrgId(requestWith(cookie));
  const fromPage = await getOrgIdFromCookieStore(cookieStoreWith(cookie));
  expect('orgId' in fromRoute ? fromRoute.orgId : null).toBe(fromPage);
  return fromPage;
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('sessions against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'last_login_at'`,
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
    vi.stubEnv('ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.churnlens.com');
    // Cascades to users, login_tokens and everything else org-scoped.
    await pool().query('TRUNCATE organizations CASCADE');
  });

  it('a session minted by the magic-link route authenticates its org, in routes and in pages', async () => {
    const orgId = await seedOrg();
    const cookie = await signIn(orgId);

    expect(await sessionOrg(cookie)).toBe(orgId);
  });

  it('each org’s session authenticates that org and no other', async () => {
    const orgA = await seedOrg('A');
    const orgB = await seedOrg('B');
    const cookieA = await signIn(orgA);
    const cookieB = await signIn(orgB);

    expect(await sessionOrg(cookieA)).toBe(orgA);
    expect(await sessionOrg(cookieB)).toBe(orgB);
  });

  it('a cookie cannot be re-pointed at another org by editing its org id', async () => {
    const orgA = await seedOrg('A');
    const orgB = await seedOrg('B');
    const [, issuedAt, signature] = (await signIn(orgA)).split('.');

    // Org B exists and is otherwise signed in fine — the only thing wrong with
    // this cookie is that A's signature does not cover B's id.
    await signIn(orgB);
    expect(await sessionOrg(`${orgB}.${issuedAt}.${signature}`)).toBeNull();
  });

  it('rejects a session for an org that no longer exists, and evicts the dead cookie', async () => {
    const orgId = await seedOrg();
    const cookie = await signIn(orgId);
    await pool().query('DELETE FROM organizations WHERE id = $1', [orgId]);

    const result = await requireOrgId(requestWith(cookie));

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.status).toBe(401);
    // Cleared on the way out, so the browser stops presenting a credential
    // that can never work again.
    expect(result.error.headers.get('set-cookie') ?? '').toMatch(
      new RegExp(`${COOKIE_NAME}=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`),
    );
    expect(await getOrgIdFromCookieStore(cookieStoreWith(cookie))).toBeNull();
  });

  it('rejects a cookie minted before this change (HMAC of the org id under the raw ENCRYPTION_KEY) for an org that exists', async () => {
    const orgId = await seedOrg();
    await signIn(orgId); // the org is real and can sign in today
    const legacy = `${orgId}.${createHmac('sha256', ENCRYPTION_KEY).update(orgId).digest('hex')}`;

    expect(await sessionOrg(legacy)).toBeNull();
  });

  it('rejects a session 30 days after it was issued, though the org is untouched', async () => {
    const orgId = await seedOrg();
    const stale = await signIn(orgId, new Date(Date.now() - 30 * DAY_MS));
    const nearlyStale = await signIn(orgId, new Date(Date.now() - 30 * DAY_MS + 60_000));

    expect(await sessionOrg(stale)).toBeNull();
    expect(await sessionOrg(nearlyStale)).toBe(orgId);
  });
});
