import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { NextRequest, NextResponse } from 'next/server';
import { assertThrowawayDatabase } from '../../../../../e2e/helpers/throwaway-db';

/**
 * POST /api/onboarding/connect against a real PostgreSQL and the real Stripe SDK.
 *
 * connect.test.ts pins the guards (CSRF, session, rate limit, the takeover
 * replay) with every boundary stubbed. This suite checks what a successful
 * connect leaves in the organizations row, which is what the Stripe webhook
 * and the dashboard read next. Real session cookie, real key encryption; only
 * Stripe's HTTP transport (src/__tests__/helpers/fake-stripe-api.ts) and the
 * in-memory rate limiter (its own suite covers it) are faked.
 *
 * Same contract as the other *.db.test.ts suites: skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database. It TRUNCATEs
 * organizations between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const dbState = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
function pool(): Pool {
  if (!dbState.pool) throw new Error('test pool not initialised');
  return dbState.pool;
}

vi.mock('@/lib/db', () => ({
  query: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows,
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
import { fakeStripeApi, stripeError, stripeJson, type FakeStripeRequest } from '@/__tests__/helpers/fake-stripe-api';

const ENCRYPTION_KEY = 'd'.repeat(64);
const APP_URL = 'https://app.churnlens.test';
const NEW_KEY = 'rk_live_new_key_after_rotation';

/** Stripe's answers for a key created per the onboarding instructions. */
function onboardingScopedKey(req: FakeStripeRequest): Response {
  if (req.method === 'POST' && req.path === '/v1/webhook_endpoints') {
    return stripeJson(200, { id: 'we_registered', object: 'webhook_endpoint', secret: 'whsec_registered' });
  }
  return stripeError(403, 'invalid_request_error', `The provided key does not have the required permissions (${req.path}).`);
}

interface OrgOpts {
  webhookRegistered?: boolean;
  /** SQL interval ago that the webhook flagged the old key, or null. */
  keyInvalidAgo?: string | null;
}

async function seedOrg(opts: OrgOpts = {}): Promise<string> {
  const { webhookRegistered = true, keyInvalidAgo = null } = opts;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations
       (name, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc, stripe_key_invalid_at)
     VALUES ('Connect suite org', $1, $2, $3, now() - $4::interval)
     RETURNING id`,
    [
      encryptApiKey('rk_live_old_revoked_key'),
      webhookRegistered ? 'we_existing' : null,
      webhookRegistered ? encryptApiKey('whsec_existing') : null,
      keyInvalidAgo,
    ],
  );
  return rows[0].id;
}

/** A request carrying a genuinely signed session for `orgId`. */
function connectRequest(orgId: string, apiKey: string): NextRequest {
  const carrier = setOrgCookie(NextResponse.next(), orgId);
  const cookie = carrier.cookies.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  return new NextRequest('http://localhost/api/onboarding/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiKey }),
  });
}

async function orgRow(orgId: string) {
  const { rows } = await pool().query<{
    stripe_api_key_enc: string | null;
    stripe_key_invalid_at: Date | null;
    stripe_webhook_id: string | null;
  }>(
    'SELECT stripe_api_key_enc, stripe_key_invalid_at, stripe_webhook_id FROM organizations WHERE id = $1',
    [orgId],
  );
  return rows[0];
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/onboarding/connect against a real database', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'stripe_key_invalid_at'`,
    );
    if (rows.length === 0) {
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    consoleErrorSpy.mockRestore();
  });

  describe('reconnecting after Stripe rejected the old key', () => {
    it('stores the new key and clears the dashboard warning', async () => {
      const orgId = await seedOrg({ keyInvalidAgo: '3 days' });

      const res = await POST(connectRequest(orgId, NEW_KEY));

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(decryptApiKey(org.stripe_api_key_enc!)).toBe(NEW_KEY);
      expect(org.stripe_key_invalid_at).toBeNull();
    });

    it('clears it on a first connect too, alongside registering the webhook', async () => {
      const orgId = await seedOrg({ webhookRegistered: false, keyInvalidAgo: '3 days' });

      const res = await POST(connectRequest(orgId, NEW_KEY));

      expect(res.status).toBe(200);
      const org = await orgRow(orgId);
      expect(org.stripe_webhook_id).toBe('we_registered');
      expect(org.stripe_key_invalid_at).toBeNull();
      // Registered with the key just saved, not the stored (revoked) one.
      expect(fakeStripeApi.requests.find((r) => r.path === '/v1/webhook_endpoints')?.apiKey).toBe(NEW_KEY);
    });
  });
});
