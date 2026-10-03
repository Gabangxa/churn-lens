import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
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
  // db.ts's withTransaction, on this suite's pool: a real BEGIN/COMMIT on one
  // dedicated connection, rolled back on any error.
  withTransaction: async <T,>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
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
import { LEGAL_DOCS_VERSION, currentLegalDocsVersion } from '@/lib/legal-version';
import { hasUnfilledPlaceholders } from '@/lib/legal';
// Real: what reaches the operator is asserted on what reportError recorded.
// ALERT_EMAIL is pinned empty for every suite (vitest.config.ts).
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';
import { fakeStripeApi, stripeError, stripeJson, type FakeStripeRequest } from '@/__tests__/helpers/fake-stripe-api';

const ENCRYPTION_KEY = 'd'.repeat(64);
const APP_URL = 'https://app.churnlens.test';
const NEW_KEY = 'rk_live_new_key_after_rotation';
const RESTRICTED_KEY = 'rk_live_db_suite';
// What the onboarding form sends and the route records: LEGAL_DOCS_VERSION,
// labelled '-draft' while legal.ts still has placeholders.
const CURRENT_VERSION = currentLegalDocsVersion();
// Every connect that is meant to succeed must carry acceptance of the current
// Terms/DPA; the acceptance suite below pins what happens without it.
const ACCEPTED = { acceptedLegalVersion: CURRENT_VERSION };

const OLD_KEY = 'rk_live_old_revoked_key';

/**
 * The webhook endpoints in the Stripe account the keys belong to, by id, as
 * Stripe returns them. seedConnectedOrg adds the org's we_existing, as this
 * route registered it; a test changes it to model an endpoint someone
 * disabled or edited since.
 */
const stripeEndpoints = new Map<string, { url: string; enabled_events: string[]; status: string }>();

/**
 * Stripe's answers for a key created per the onboarding instructions
 * (customers:read, subscriptions:read, webhooks:write) on the same account as
 * the org's existing endpoint, we_existing: the key check's customer list, the
 * endpoint lookup, registration and deletion work; the account read does not.
 */
function onboardingScopedKey(req: FakeStripeRequest): Response {
  if (req.method === 'GET' && req.path === '/v1/customers') {
    return stripeJson(200, { object: 'list', data: [], has_more: false, url: '/v1/customers' });
  }
  if (req.method === 'POST' && req.path === '/v1/webhook_endpoints') {
    return stripeJson(200, { id: 'we_registered', object: 'webhook_endpoint', secret: 'whsec_registered' });
  }
  if (req.path.startsWith('/v1/webhook_endpoints/')) {
    const id = req.path.slice('/v1/webhook_endpoints/'.length);
    if (req.method === 'DELETE') return stripeJson(200, { id, object: 'webhook_endpoint', deleted: true });
    const endpoint = stripeEndpoints.get(id);
    return endpoint ? stripeJson(200, { id, object: 'webhook_endpoint', ...endpoint }) : noSuchEndpoint();
  }
  return stripeError(403, 'invalid_request_error', `The provided key does not have the required permissions (${req.path}).`);
}

/** onboardingScopedKey, except that the requests `matches` picks get `response` instead. */
function except(matches: (req: FakeStripeRequest) => boolean, response: () => Response) {
  return (req: FakeStripeRequest): Response => (matches(req) ? response() : onboardingScopedKey(req));
}

const isKeyCheck = (req: FakeStripeRequest) => req.method === 'GET' && req.path === '/v1/customers';
const isRegistration = (req: FakeStripeRequest) => req.method === 'POST' && req.path === '/v1/webhook_endpoints';
const isEndpointLookup = (req: FakeStripeRequest) =>
  req.method === 'GET' && req.path.startsWith('/v1/webhook_endpoints/');
const isEndpointDelete = (req: FakeStripeRequest) =>
  req.method === 'DELETE' && req.path.startsWith('/v1/webhook_endpoints/');

const revokedKey = () => stripeError(401, 'invalid_request_error', 'Invalid API Key provided: rk_live_****_key');
const missingPermission = () =>
  stripeError(403, 'invalid_request_error', 'The provided key does not have the required permissions.');
/** What Stripe answers for an endpoint id from another account or mode. */
const noSuchEndpoint = () =>
  stripeError(404, 'invalid_request_error', "No such webhook endpoint: 'we_existing'", { code: 'resource_missing' });

/** The requests the route made, as "METHOD /path (key)" lines in order. */
function stripeCalls(): string[] {
  return fakeStripeApi.requests.map((r) => `${r.method} ${r.path} (${r.apiKey})`);
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

/** An org that already has a (now revoked) key connected, OLD_KEY. */
async function seedConnectedOrg(opts: OrgOpts = {}): Promise<string> {
  const { webhookRegistered = true, keyInvalidAgo = null, stripeBusinessName = null } = opts;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations
       (name, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc,
        stripe_key_invalid_at, stripe_business_name)
     VALUES ('Connect suite org', $1, $2, $3, now() - $4::interval, $5)
     RETURNING id`,
    [
      encryptApiKey(OLD_KEY),
      webhookRegistered ? 'we_existing' : null,
      webhookRegistered ? encryptApiKey('whsec_existing') : null,
      keyInvalidAgo,
      stripeBusinessName,
    ],
  );
  if (webhookRegistered) {
    stripeEndpoints.set('we_existing', {
      url: `${APP_URL}/api/webhooks/stripe/${rows[0].id}`,
      enabled_events: ['customer.subscription.deleted'],
      status: 'enabled',
    });
  }
  return rows[0].id;
}

/**
 * An org that has never connected Stripe, optionally with an acceptance
 * already on record the way the app leaves one: the organizations cache
 * columns and the matching legal_acceptances row.
 */
async function seedUnconnectedOrg(acceptance?: { version: string; acceptedAt: Date }): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations (name, legal_accepted_version, legal_accepted_at)
     VALUES ('db-suite org', $1, $2)
     RETURNING id`,
    [acceptance?.version ?? null, acceptance?.acceptedAt ?? null],
  );
  if (acceptance) {
    await pool().query(
      `INSERT INTO legal_acceptances (org_id, version, accepted_at, source)
       VALUES ($1, $2, $3, 'banner')`,
      [rows[0].id, acceptance.version, acceptance.acceptedAt],
    );
  }
  return rows[0].id;
}

/** Every Terms/DPA acceptance on record for the org, oldest first. */
async function acceptanceHistory(orgId: string) {
  const { rows } = await pool().query<{ version: string; accepted_at: Date; source: string }>(
    `SELECT version, accepted_at, source FROM legal_acceptances
     WHERE org_id = $1 ORDER BY accepted_at, version`,
    [orgId],
  );
  return rows;
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

/** The org's Stripe connection, decrypted: what the webhook will use next. */
async function connection(orgId: string) {
  const { rows } = await pool().query<{
    stripe_api_key_enc: string | null;
    stripe_webhook_id: string | null;
    stripe_webhook_secret_enc: string | null;
  }>('SELECT stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc FROM organizations WHERE id = $1', [
    orgId,
  ]);
  const row = rows[0];
  return {
    apiKey: row.stripe_api_key_enc === null ? null : decryptApiKey(row.stripe_api_key_enc),
    webhookId: row.stripe_webhook_id,
    webhookSecret: row.stripe_webhook_secret_enc === null ? null : decryptApiKey(row.stripe_webhook_secret_enc),
  };
}

/** Everything a never-connected org's row holds about Stripe and the Terms: nothing. */
const NOTHING_STORED = {
  stripe_api_key_enc: null,
  stripe_key_invalid_at: null,
  stripe_webhook_id: null,
  stripe_business_name: null,
  legal_accepted_at: null,
  legal_accepted_version: null,
};

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
         AND column_name IN ('stripe_business_name', 'legal_accepted_version')
       UNION ALL
       SELECT 'legal_acceptances' WHERE to_regclass('legal_acceptances') IS NOT NULL`,
    );
    if (rows.length !== 3) {
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
    stripeEndpoints.clear();
    fakeStripeApi.reset(onboardingScopedKey);
    resetErrorReports();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('checking the key with Stripe before anything is stored', () => {
    // A key Stripe will not answer for can never survey anyone. Stored, it
    // used to clear the dashboard's warning and read as "sending" until the
    // next cancellation was skipped as stripe_key_invalid — lost for good.

    it.each([
      ['revoked or mistyped (401)', revokedKey],
      ['missing customers:read (403)', missingPermission],
    ])('refuses a key Stripe rejects as %s, and stores nothing', async (_why, rejection) => {
      fakeStripeApi.reset(except(isKeyCheck, rejection));
      const orgId = await seedUnconnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: RESTRICTED_KEY, ...ACCEPTED }));

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/^Stripe rejected this key/);
      expect(await orgRow(orgId)).toEqual(NOTHING_STORED);
      // Checked first: no endpoint is registered for a key that cannot read
      // the customers its events would name.
      expect(stripeCalls()).toEqual([`GET /v1/customers (${RESTRICTED_KEY})`]);
      // The founder's input, answered in the form — not an operator alert.
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });

    it("leaves a flagged org's old key, flag and name alone when the new key is rejected too", async () => {
      const orgId = await seedConnectedOrg({ keyInvalidAgo: '3 days', stripeBusinessName: 'Acme Analytics' });
      const before = await orgRow(orgId);
      fakeStripeApi.reset(except(isKeyCheck, revokedKey));

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(422);
      // The dashboard keeps saying "reconnect", which is still true.
      expect(await orgRow(orgId)).toEqual(before);
      expect((await connection(orgId)).apiKey).toBe(OLD_KEY);
    });

    it('stores nothing, and alerts the operator, when Stripe cannot be asked at all', async () => {
      fakeStripeApi.reset(except(isKeyCheck, () => stripeError(503, 'api_error', 'Service unavailable.')));
      const orgId = await seedUnconnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: RESTRICTED_KEY, ...ACCEPTED }));

      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/Nothing was saved/);
      expect(await orgRow(orgId)).toEqual(NOTHING_STORED);
      const { recent } = getErrorReportSnapshot();
      expect(recent).toEqual([
        expect.objectContaining({ context: 'onboarding.connect', meta: { orgId, step: 'stripe_key_check' } }),
      ]);
      expect(JSON.stringify(recent)).not.toContain(RESTRICTED_KEY);
    });
  });

  describe('a first connect whose webhook registration fails', () => {
    // A stored key with no endpoint is an org no event can ever reach, which
    // the dashboard used to call "sending automatically".

    it.each([
      ['rejects the key (401)', revokedKey],
      ['refuses it webhooks:write (403)', missingPermission],
    ])('stores nothing when Stripe %s at registration', async (_why, rejection) => {
      fakeStripeApi.reset(except(isRegistration, rejection));
      const orgId = await seedUnconnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: RESTRICTED_KEY, ...ACCEPTED }));

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/^Stripe rejected this key/);
      expect(await orgRow(orgId)).toEqual(NOTHING_STORED);
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });

    it("stores nothing, and reports it, when registration fails on Stripe's side", async () => {
      fakeStripeApi.reset(except(isRegistration, () => stripeError(500, 'api_error', 'stripe is down')));
      const orgId = await seedUnconnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: RESTRICTED_KEY, ...ACCEPTED }));

      expect(res.status).toBe(502);
      expect(await orgRow(orgId)).toEqual(NOTHING_STORED);
      expect(getErrorReportSnapshot().recent).toEqual([
        expect.objectContaining({ context: 'onboarding.connect', meta: { orgId, step: 'stripe_webhook' } }),
      ]);
    });

    it('stores the key, endpoint and signing secret together once registration succeeds', async () => {
      const orgId = await seedUnconnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: RESTRICTED_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(await connection(orgId)).toEqual({
        apiKey: RESTRICTED_KEY,
        webhookId: 'we_registered',
        webhookSecret: 'whsec_registered',
      });
      expect(stripeCalls()).toEqual([
        `GET /v1/customers (${RESTRICTED_KEY})`,
        `POST /v1/webhook_endpoints (${RESTRICTED_KEY})`,
        `GET /v1/account (${RESTRICTED_KEY})`,
      ]);
    });

    it('deletes the endpoint it just registered when the org is gone before the key is saved', async () => {
      // The org was deleted between the session check and the save. Nothing
      // can be stored, and an endpoint left behind would keep posting the
      // founder's cancellations at a URL that answers for nobody.
      const orgId = await seedUnconnectedOrg();
      fakeStripeApi.reset(async (req) => {
        if (isRegistration(req)) await pool().query('DELETE FROM organizations WHERE id = $1', [orgId]);
        return onboardingScopedKey(req);
      });

      const res = await POST(connectRequest(orgId, { apiKey: RESTRICTED_KEY, ...ACCEPTED }));

      expect(res.status).toBe(401);
      expect(stripeCalls()).toContain(`DELETE /v1/webhook_endpoints/we_registered (${RESTRICTED_KEY})`);
    });
  });

  describe('reconnecting an org that already has a webhook endpoint', () => {
    it('keeps the endpoint when the new key can see it — same Stripe account and mode', async () => {
      const orgId = await seedConnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      expect(await connection(orgId)).toEqual({
        apiKey: NEW_KEY,
        webhookId: 'we_existing',
        webhookSecret: 'whsec_existing',
      });
      // Looked up with the NEW key, which is what decides whose events the
      // endpoint's customers can be read from. Nothing registered or deleted.
      expect(stripeCalls()).toEqual([
        `GET /v1/customers (${NEW_KEY})`,
        `GET /v1/webhook_endpoints/we_existing (${NEW_KEY})`,
        `GET /v1/account (${NEW_KEY})`,
      ]);
    });

    it('registers a new endpoint when the key is for another account or mode, and removes the old one', async () => {
      // rk_test_ → rk_live_, or another business's account entirely: the old
      // endpoint is not visible to the new key, and its events could never be
      // looked up with it. It used to be kept, so the new account had no
      // endpoint at all while the dashboard said "sending".
      const orgId = await seedConnectedOrg({ keyInvalidAgo: '1 day' });
      fakeStripeApi.reset(except(isEndpointLookup, noSuchEndpoint));

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      expect(await connection(orgId)).toEqual({
        apiKey: NEW_KEY,
        webhookId: 'we_registered',
        webhookSecret: 'whsec_registered',
      });
      expect((await orgRow(orgId)).stripe_key_invalid_at).toBeNull();
      expect(stripeCalls()).toEqual([
        `GET /v1/customers (${NEW_KEY})`,
        `GET /v1/webhook_endpoints/we_existing (${NEW_KEY})`,
        `POST /v1/webhook_endpoints (${NEW_KEY})`,
        `GET /v1/account (${NEW_KEY})`,
        // The old endpoint lives on the old account, so only the old key can
        // remove it — and only once the new connection is saved.
        `DELETE /v1/webhook_endpoints/we_existing (${OLD_KEY})`,
      ]);
    });

    it.each([
      ['disabled in Stripe', { status: 'disabled' }],
      ['pointed at another URL', { url: 'https://old-domain.example/api/webhooks/stripe/elsewhere' }],
      ["no longer sending customer.subscription.deleted", { enabled_events: ['invoice.paid'] }],
    ])(
      'registers a new endpoint when the one the key can see is %s, and removes the old one with the new key',
      async (_label, change) => {
        // Kept, it would deliver nothing (or deliver it elsewhere) while the
        // dashboard said surveys were sending.
        const orgId = await seedConnectedOrg();
        Object.assign(stripeEndpoints.get('we_existing')!, change);

        const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

        expect(res.status).toBe(200);
        expect(await connection(orgId)).toEqual({
          apiKey: NEW_KEY,
          webhookId: 'we_registered',
          webhookSecret: 'whsec_registered',
        });
        expect(stripeCalls()).toEqual([
          `GET /v1/customers (${NEW_KEY})`,
          `GET /v1/webhook_endpoints/we_existing (${NEW_KEY})`,
          `POST /v1/webhook_endpoints (${NEW_KEY})`,
          `GET /v1/account (${NEW_KEY})`,
          // Visible to the new key, so removed with it: the old key is often
          // revoked by now, the usual reason to reconnect.
          `DELETE /v1/webhook_endpoints/we_existing (${NEW_KEY})`,
        ]);
        expect(getErrorReportSnapshot().totalReported).toBe(0);
      },
    );

    it("keeps an endpoint that sends every event type ('*')", async () => {
      const orgId = await seedConnectedOrg();
      stripeEndpoints.get('we_existing')!.enabled_events = ['*'];

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      expect((await connection(orgId)).webhookId).toBe('we_existing');
      expect(stripeCalls()).not.toContain(`POST /v1/webhook_endpoints (${NEW_KEY})`);
    });

    it('still connects when the old endpoint cannot be removed, with a warning rather than an alert', async () => {
      // The usual reason to reconnect is that the old key was revoked.
      fakeStripeApi.reset((req) => {
        if (isEndpointLookup(req)) return noSuchEndpoint();
        if (isEndpointDelete(req) && req.apiKey === OLD_KEY) return revokedKey();
        return onboardingScopedKey(req);
      });
      const orgId = await seedConnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(200);
      expect((await connection(orgId)).webhookId).toBe('we_registered');
      expect(getErrorReportSnapshot().totalReported).toBe(0);
      const warned = consoleWarnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(warned).toContain(orgId);
      expect(warned).toContain('we_existing');
      expect(warned).not.toContain(OLD_KEY);
      expect(warned).not.toContain(NEW_KEY);
    });

    it('refuses a new key that may not see webhook endpoints, and keeps the old connection', async () => {
      fakeStripeApi.reset(except(isEndpointLookup, missingPermission));
      const orgId = await seedConnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(422);
      expect(await connection(orgId)).toEqual({
        apiKey: OLD_KEY,
        webhookId: 'we_existing',
        webhookSecret: 'whsec_existing',
      });
    });

    it("keeps the old connection, and reports it, when the endpoint lookup fails on Stripe's side", async () => {
      fakeStripeApi.reset(except(isEndpointLookup, () => stripeError(500, 'api_error', 'stripe is down')));
      const orgId = await seedConnectedOrg();

      const res = await POST(connectRequest(orgId, { apiKey: NEW_KEY, ...ACCEPTED }));

      expect(res.status).toBe(502);
      expect((await connection(orgId)).apiKey).toBe(OLD_KEY);
      expect(getErrorReportSnapshot().recent).toEqual([
        expect.objectContaining({ context: 'onboarding.connect', meta: { orgId, step: 'stripe_webhook_lookup' } }),
      ]);
    });
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
      expect(await acceptanceHistory(orgId)).toEqual([]);
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
      expect(await acceptanceHistory(orgId)).toEqual([
        { version: priorAcceptance.version, accepted_at: priorAcceptance.acceptedAt, source: 'banner' },
      ]);
      expect(fakeStripeApi.requests).toEqual([]);
    });

    // Only meaningful while legal.ts is unfilled, which legal.test.ts pins as
    // today's state; once it is filled there is no draft left to mislabel.
    (hasUnfilledPlaceholders() ? it : it.skip)(
      'refuses the bare version while the documents are drafts, so no acceptance reads as final',
      async () => {
        // The pages carry "Draft — do not rely on it". Recorded as the bare
        // LEGAL_DOCS_VERSION, this acceptance would silently become one of
        // the final contract the day legal.ts is filled in.
        const orgId = await seedUnconnectedOrg();

        const res = await POST(
          connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: LEGAL_DOCS_VERSION }),
        );

        expect(res.status).toBe(400);
        expect((await orgRow(orgId)).stripe_api_key_enc).toBeNull();
        expect(await acceptanceHistory(orgId)).toEqual([]);
      },
    );

    it('records acceptance of the current version, on the database clock, together with the key', async () => {
      const orgId = await seedUnconnectedOrg();
      const before = await dbClock();

      const res = await POST(
        connectRequest(orgId, {
          apiKey: RESTRICTED_KEY,
          acceptedLegalVersion: CURRENT_VERSION,
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
      expect(org.legal_accepted_version).toBe(CURRENT_VERSION);
      expect(org.legal_accepted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(org.legal_accepted_at!.getTime()).toBeLessThanOrEqual(after.getTime());
      // The history row and the cache are one write: same version, same time.
      expect(await acceptanceHistory(orgId)).toEqual([
        { version: CURRENT_VERSION, accepted_at: org.legal_accepted_at, source: 'connect' },
      ]);
    });

    it('records no acceptance when the connect then fails — it rides with the key, and no key is stored', async () => {
      // The acceptance commits in the same transaction as the key, and that
      // transaction only runs once Stripe has accepted the key and the webhook.
      // A failed connect stores no key, so nothing is processed under the
      // agreement; the founder ticks the box again on the retry.
      fakeStripeApi.reset(except(isRegistration, () => stripeError(500, 'api_error', 'stripe is down')));
      const orgId = await seedUnconnectedOrg();

      const res = await POST(
        connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: CURRENT_VERSION }),
      );

      expect(res.status).toBe(502);
      expect(await orgRow(orgId)).toEqual(NOTHING_STORED);
      expect(await acceptanceHistory(orgId)).toEqual([]);
    });

    it('moves an org that accepted an older version onto the current one and keeps the old record', async () => {
      // The older acceptance is the wording that covered everything processed
      // before today; it must survive the new one.
      const prior = { version: '2000-01-01', acceptedAt: new Date('2025-01-01T00:00:00Z') };
      const orgId = await seedUnconnectedOrg(prior);
      const before = await dbClock();

      const res = await POST(
        connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: CURRENT_VERSION }),
      );

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.legal_accepted_version).toBe(CURRENT_VERSION);
      expect(org.legal_accepted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(await acceptanceHistory(orgId)).toEqual([
        { version: prior.version, accepted_at: prior.acceptedAt, source: 'banner' },
        { version: CURRENT_VERSION, accepted_at: org.legal_accepted_at, source: 'connect' },
      ]);
    });

    it('reconnecting under the version already on record keeps the original acceptance time', async () => {
      // Replacing a key is not a new agreement to the same text; the record
      // should still say when the founder first agreed to this wording.
      const firstAcceptedAt = new Date('2026-01-15T09:30:00Z');
      const orgId = await seedUnconnectedOrg({ version: CURRENT_VERSION, acceptedAt: firstAcceptedAt });

      const res = await POST(
        connectRequest(orgId, { apiKey: RESTRICTED_KEY, acceptedLegalVersion: CURRENT_VERSION }),
      );

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.stripe_api_key_enc).not.toBeNull();
      expect(org.legal_accepted_version).toBe(CURRENT_VERSION);
      expect(org.legal_accepted_at).toEqual(firstAcceptedAt);
      // No second row for the same wording, and the first keeps its door.
      expect(await acceptanceHistory(orgId)).toEqual([
        { version: CURRENT_VERSION, accepted_at: firstAcceptedAt, source: 'banner' },
      ]);
    });
  });
});
