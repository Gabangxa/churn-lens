import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { NextRequest, NextResponse } from 'next/server';
import { assertThrowawayDatabase } from '../../../../../e2e/helpers/throwaway-db';

/**
 * POST /api/onboarding/connect against a real PostgreSQL and the real Stripe SDK.
 *
 * connect.test.ts pins the guards (CSRF, session, rate limit, the takeover
 * replay) with every boundary stubbed, so it can only say which SQL the route
 * emits. This suite checks what a connect leaves in the organizations row,
 * which is what the Stripe webhook and the dashboard read next — and whether
 * a refused connect really stores nothing, and whether the recorded Terms/DPA
 * acceptance time really is the database's clock rather than anything the
 * client sent. Those are facts about rows, so they are asserted on rows.
 *
 * Real session cookie, real key encryption. Only Stripe's HTTP transport
 * (src/__tests__/helpers/fake-stripe-api.ts) and the in-memory rate limiter
 * (its own suite covers it, and this file would exhaust its 8-per-10-minutes
 * budget) are faked.
 *
 * Same contract as the other *.db.test.ts suites: skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database, which CI
 * provisions. It TRUNCATEs organizations between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const dbState = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
function pool(): Pool {
  if (!dbState.pool) throw new Error('test pool not initialised');
  return dbState.pool;
}

vi.mock('@/lib/db', () => ({
  query: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows,
  execute: async (text: string, params?: unknown[]) =>
    (await pool().query(text, params)).rowCount ?? 0,
  queryOne: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows[0] ?? null,
}));

vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
  clientIp: () => '203.0.113.7',
}));

vi.mock('stripe', async (importOriginal) => {
  const { stripeModuleOverFakeApi } = await import('@/__tests__/helpers/fake-stripe-api');
  return stripeModuleOverFakeApi(await importOriginal<typeof import('stripe')>());
});

import { POST } from '../connect/route';
import { setOrgCookie } from '@/lib/auth';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto';
import { LEGAL_DOCS_VERSION } from '@/lib/legal-version';
import { fakeStripeApi, stripeError, stripeJson, type FakeStripeRequest } from '@/__tests__/helpers/fake-stripe-api';

const ENCRYPTION_KEY = 'd'.repeat(64);
const APP_URL = 'https://app.churnlens.test';
const NEW_KEY = 'rk_live_new_key_after_rotation';
const RESTRICTED_KEY = 'rk_live_db_suite';
// Every connect that is meant to succeed must carry acceptance of the current
// Terms/DPA; the acceptance suite below pins what happens without it.
const ACCEPTED = { acceptedLegalVersion: LEGAL_DOCS_VERSION };

/** Stripe's answers for a key created per the onboarding instructions. */
function onboardingScopedKey(req: FakeStripeRequest): Response {
  if (req.method === 'POST' && req.path === '/v1/webhook_endpoints') {
    return stripeJson(200, { id: 'we_registered', object: 'webhook_endpoint', secret: 'whsec_registered' });
  }
  return stripeError(403, 'invalid_request_error', `The provided key does not have the required permissions (${req.path}).`);
}

/** onboardingScopedKey, plus read access to the account (a permission onboarding does not ask for). */
function keyWithAccountRead(account: Record<string, unknown>) {
  return (req: FakeStripeRequest): Response =>
    req.method === 'GET' && req.path === '/v1/account'
      ? stripeJson(200, { id: 'acct_connect_suite', object: 'account', ...account })
      : onboardingScopedKey(req);
}

interface OrgOpts {
  webhookRegistered?: boolean;
  /** SQL interval ago that the webhook flagged the old key, or null. */
  keyInvalidAgo?: string | null;
  /** A name cached from the previously connected key. */
  stripeBusinessName?: string | null;
}

/** An org that already has a (now revoked) key connected. */
async function seedConnectedOrg(opts: OrgOpts = {}): Promise<string> {
  const { webhookRegistered = true, keyInvalidAgo = null, stripeBusinessName = null } = opts;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations
       (name, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc,
        stripe_key_invalid_at, stripe_business_name)
     VALUES ('Connect suite org', $1, $2, $3, now() - $4::interval, $5)
     RETURNING id`,
    [
      encryptApiKey('rk_live_old_revoked_key'),
      webhookRegistered ? 'we_existing' : null,
      webhookRegistered ? encryptApiKey('whsec_existing') : null,
      keyInvalidAgo,
      stripeBusinessName,
    ],
  );
  return rows[0].id;
}

/** An org that has never connected Stripe, optionally with an acceptance already on record. */
async function seedUnconnectedOrg(acceptance?: { version: string; acceptedAt: Date }): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations (name, legal_accepted_version, legal_accepted_at)
     VALUES ('db-suite org', $1, $2)
     RETURNING id`,
    [acceptance?.version ?? null, acceptance?.acceptedAt ?? null],
  );
  return rows[0].id;
}

/** A request carrying a genuinely signed session for `orgId`. */
function connectRequest(orgId: string, body: Record<string, unknown>): NextRequest {
  const carrier = setOrgCookie(NextResponse.next(), orgId);
  const cookie = carrier.cookies.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  return new NextRequest('http://localhost/api/onboarding/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function orgRow(orgId: string) {
  const { rows } = await pool().query<{
    stripe_api_key_enc: string | null;
    stripe_key_invalid_at: Date | null;
    stripe_webhook_id: string | null;
    stripe_business_name: string | null;
    legal_accepted_at: Date | null;
    legal_accepted_version: string | null;
  }>(
    `SELECT stripe_api_key_enc, stripe_key_invalid_at, stripe_webhook_id, stripe_business_name,
            legal_accepted_at, legal_accepted_version
     FROM organizations WHERE id = $1`,
    [orgId],
  );
  return rows[0];
}

/** The database's own clock, read outside any statement under test. */
async function dbClock(): Promise<Date> {
  const { rows } = await pool().query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return rows[0].now;
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/onboarding/connect against a real database', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'organizations'
         AND column_name IN ('stripe_business_name', 'legal_accepted_version')`,
    );
    if (rows.length !== 2) {
      throw new Error('TEST_DATABASE_URL is not migrated — run `node scripts/migrate.js` against it first.');
    }
  });

  afterAll(async () => {
    await dbState.pool?.end();
    dbState.pool = null;
  });

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    await pool().query('TRUNCATE organizations CASCADE');
    fakeStripeApi.reset(onboardingScopedKey);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('reconnecting after Stripe rejected the old key', () => {
    it('stores the new key and clears the dashboard warning', async () => {
      const orgId = await seedConnectedOrg({ keyInvalidAgo: '3 days' });

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(decryptApiKey(org.stripe_api_key_enc!)).toBe(NEW_KEY);
      expect(org.stripe_key_invalid_at).toBeNull();
    });

    it('clears it on a first connect too, alongside registering the webhook', async () => {
      const orgId = await seedConnectedOrg({ webhookRegistered: false, keyInvalidAgo: '3 days' });

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.stripe_webhook_id).toBe('we_registered');
      expect(org.stripe_key_invalid_at).toBeNull();
      // Registered with the key just saved, not the stored (revoked) one.
      expect(fakeStripeApi.requests.find((r) => r.path === '/v1/webhook_endpoints')?.apiKey).toBe(NEW_KEY);
    });
  });

  describe("caching the Stripe account's business name for the survey copy", () => {
    it('stores the name the new key can read', async () => {
      const orgId = await seedConnectedOrg();
      fakeStripeApi.reset(keyWithAccountRead({ business_profile: { name: 'Acme Analytics' } }));

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      expect((await orgRow(orgId)).stripe_business_name).toBe('Acme Analytics');
      expect(fakeStripeApi.requests.find((r) => r.path === '/v1/account')?.apiKey).toBe(NEW_KEY);
    });

    it('connects a key that may not read the account — no new required permission — and caches no name', async () => {
      const orgId = await seedConnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.stripe_business_name).toBeNull();
      expect(decryptApiKey(org.stripe_api_key_enc!)).toBe(NEW_KEY);
      // A 403 on the account is not a 403 on what surveys need.
      expect(org.stripe_key_invalid_at).toBeNull();
      // Explained in the log by org id, never by key.
      const logged = consoleWarnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(logged).toContain(orgId);
      expect(logged).not.toContain(NEW_KEY);
    });

    it("drops a name cached from the previous key when the new key can't confirm one", async () => {
      // The new key may belong to a different Stripe account; surveys must not
      // go out naming the old business.
      const orgId = await seedConnectedOrg({ stripeBusinessName: 'Previous Business Ltd' });

      await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect((await orgRow(orgId)).stripe_business_name).toBeNull();
    });
  });

  describe('Terms/DPA acceptance', () => {
    it.each([
      ['no acceptance field at all', {}],
      ['acceptance as a bare boolean', { acceptedLegalVersion: true }],
      ['an explicit null', { acceptedLegalVersion: null }],
      ['an empty string', { acceptedLegalVersion: '' }],
    ])('refuses a connect with %s, and stores nothing', async (_label, extra) => {
      const orgId = await seedUnconnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: RESTRICTED_KEY, ...extra }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(
        /accept the Terms of Service and Data Processing Agreement/,
      );
      expect(await orgRow(orgId)).toEqual({
        stripe_api_key_enc: null,
        stripe_key_invalid_at: null,
        stripe_webhook_id: null,
        stripe_business_name: null,
        legal_accepted_at: null,
        legal_accepted_version: null,
      });
      // Refused before the key is used for anything — not even the optional
      // business-name lookup reaches Stripe.
      expect(fakeStripeApi.requests).toEqual([]);
    });

    it('refuses acceptance of a version that is no longer current, and leaves the old record alone', async () => {
      // A form loaded before a version bump still carries the old string. The
      // founder ticked a box next to text that has since changed.
      const priorAcceptance = { version: '2000-01-01', acceptedAt: new Date('2025-01-01T00:00:00Z') };
      const orgId = await seedUnconnectedOrg(priorAcceptance);

      const res = await POST(
        connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: '2000-01-01' }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/changed .*Reload the page/);
      expect(await orgRow(orgId)).toEqual({
        stripe_api_key_enc: null,
        stripe_key_invalid_at: null,
        stripe_webhook_id: null,
        stripe_business_name: null,
        legal_accepted_at: priorAcceptance.acceptedAt,
        legal_accepted_version: priorAcceptance.version,
      });
      expect(fakeStripeApi.requests).toEqual([]);
    });

    it('records acceptance of the current version, on the database clock, together with the key', async () => {
      const orgId = await seedUnconnectedOrg();
      const before = await dbClock();

      const res = await POST(
        connectRequest(orgId, {
          apiKey: RESTRICTED_KEY,
          acceptedLegalVersion: LEGAL_DOCS_VERSION,
          // A client trying to choose its own acceptance time is ignored.
          legalAcceptedAt: '1999-01-01T00:00:00.000Z',
          acceptedAt: '1999-01-01T00:00:00.000Z',
        }),
      );
      const after = await dbClock();

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.stripe_api_key_enc).not.toBeNull();
      expect(org.stripe_api_key_enc).not.toContain(RESTRICTED_KEY);
      expect(org.stripe_webhook_id).toBe('we_registered');
      expect(org.legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
      expect(org.legal_accepted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(org.legal_accepted_at!.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('keeps the acceptance even when webhook registration then fails — the founder did agree', async () => {
      // The key is stored before Stripe is called (existing behaviour), and the
      // acceptance rides in the same statement, so there is never a stored key
      // without an acceptance beside it.
      fakeStripeApi.reset((req) =>
        req.path === '/v1/webhook_endpoints'
          ? stripeError(500, 'api_error', 'stripe is down')
          : onboardingScopedKey(req),
      );
      const orgId = await seedUnconnectedOrg();

      const res = await POST(
        connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: LEGAL_DOCS_VERSION }),
      );

      expect(res.status).toBe(422);
      const org = await orgRow(orgId);
      expect(org.stripe_api_key_enc).not.toBeNull();
      expect(org.legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
      expect(org.legal_accepted_at).not.toBeNull();
    });

    it('moves an org that accepted an older version onto the current one, with a fresh time', async () => {
      const orgId = await seedUnconnectedOrg({ version: '2000-01-01', acceptedAt: new Date('2025-01-01T00:00:00Z') });
      const before = await dbClock();

      const res = await POST(
        connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: LEGAL_DOCS_VERSION }),
      );

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
      expect(org.legal_accepted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('reconnecting under the version already on record keeps the original acceptance time', async () => {
      // Replacing a key is not a new agreement to the same text; the record
      // should still say when the founder first agreed to this wording.
      const firstAcceptedAt = new Date('2026-01-15T09:30:00Z');
      const orgId = await seedUnconnectedOrg({ version: LEGAL_DOCS_VERSION, acceptedAt: firstAcceptedAt });

      const res = await POST(
        connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: LEGAL_DOCS_VERSION }),
      );

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.stripe_api_key_enc).not.toBeNull();
      expect(org.legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
      expect(org.legal_accepted_at).toEqual(firstAcceptedAt);
    });
  });
});
