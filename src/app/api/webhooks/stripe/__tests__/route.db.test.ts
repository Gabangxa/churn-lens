import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { assertThrowawayDatabase } from '../../../../../../e2e/helpers/throwaway-db';

/**
 * The Stripe webhook against a real PostgreSQL and the real Stripe SDK.
 *
 * route.test.ts stubs every boundary, so it can say which statements the route
 * emits but not what they do to rows, and its Stripe errors are hand-made
 * classes rather than what the SDK actually throws. Here the route runs as in
 * production except for four things: @/lib/db, pointed at the test pool;
 * legalFooterReady(), forced true (legal.ts is deliberately unfilled until
 * launch, and that gate has its own tests); Stripe's HTTP transport (a fetch
 * function standing in for api.stripe.com, so the SDK's own status-code →
 * error-class mapping runs); and Resend (so the real survey email is rendered
 * and captured, not sent). Signature verification, token signing and key
 * encryption are all real.
 *
 * Same contract as src/app/api/purge/__tests__/route.db.test.ts: skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database, which CI provisions.
 * It TRUNCATEs organizations and unsubscribes between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const dbState = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
function pool(): Pool {
  if (!dbState.pool) throw new Error('test pool not initialised');
  return dbState.pool;
}

vi.mock('@/lib/db', () => ({
  query: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows,
  execute: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rowCount ?? 0,
  queryOne: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows[0] ?? null,
  queryCount: async (text: string, params?: unknown[]) =>
    parseInt((await pool().query(text, params)).rows[0]?.count ?? '0', 10),
}));

// src/lib/legal.ts is deliberately unfilled until launch, which makes the route
// skip everything as 'legal_footer_unfilled'. That gate has its own tests.
vi.mock('@/lib/legal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/legal')>()),
  legalFooterReady: () => true,
}));

interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
}
const sentEmails = vi.hoisted(() => [] as CapturedEmail[]);
vi.mock('@/lib/resend', () => ({
  FROM_EMAIL: 'surveys@churnlens.test',
  getResend: () => ({
    emails: {
      send: async (message: CapturedEmail) => {
        sentEmails.push(message);
        return { data: { id: `email_${sentEmails.length}` }, error: null };
      },
    },
  }),
}));

/** One request the SDK made to the fake api.stripe.com. */
interface StripeApiRequest {
  method: string;
  path: string;
  apiKey: string;
}

/**
 * The fake api.stripe.com. `respond` decides each answer; tests replace it to
 * make Stripe reject the key, rate-limit, fall over, or vanish from the network.
 */
const stripeApi = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; path: string; apiKey: string }>,
  respond: null as null | ((req: { method: string; path: string; apiKey: string }) => Promise<Response> | Response),
  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const req = {
      method: init?.method ?? 'GET',
      path: new URL(String(url)).pathname,
      apiKey: authorization.replace(/^Bearer /, ''),
    };
    this.requests.push(req);
    if (!this.respond) throw new Error('fake Stripe API has no responder');
    return this.respond(req);
  },
}));

vi.mock('stripe', async (importOriginal) => {
  const { default: RealStripe } = await importOriginal<typeof import('stripe')>();
  // The route does `new Stripe(key, config)` and also uses the statics
  // Stripe.webhooks and Stripe.errors. A plain function constructor that
  // returns a real client keeps both working: `new` hands back the returned
  // object, and the prototype link forwards every static to the real class.
  function StripeOverFakeApi(apiKey: string, config?: Stripe.StripeConfig) {
    return new RealStripe(apiKey, {
      ...config,
      httpClient: RealStripe.createFetchHttpClient((url: string | URL, init?: RequestInit) =>
        stripeApi.fetch(url, init),
      ),
      // The SDK's own retry (1 by default) only adds a backoff sleep here; what
      // is under test is how the route classifies the error that comes out.
      maxNetworkRetries: 0,
    });
  }
  Object.setPrototypeOf(StripeOverFakeApi, RealStripe);
  return { default: StripeOverFakeApi };
});

import { POST } from '../[orgId]/route';
import { encryptApiKey } from '@/lib/crypto';

const ENCRYPTION_KEY = 'c'.repeat(64);
const APP_URL = 'https://app.churnlens.test';
const WEBHOOK_SECRET = 'whsec_db_suite_secret';
const API_KEY = 'rk_live_db_suite_key';
const CUSTOMER_ID = 'cus_jane';
const CUSTOMER_EMAIL = 'jane@example.com';

// ─── Fake Stripe responses ────────────────────────────────────────────────

function stripeJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'request-id': 'req_fake',
      // Real Stripe sends this on most 4xx/5xx; it keeps the SDK from retrying.
      'stripe-should-retry': 'false',
    },
  });
}

function stripeError(status: number, type: string, message: string): Response {
  return stripeJson(status, { error: { type, message } });
}

const customerJson = {
  id: CUSTOMER_ID,
  object: 'customer',
  email: CUSTOMER_EMAIL,
  name: 'Jane Customer',
};

/**
 * What a key created per the onboarding instructions (customers:read,
 * subscriptions:read, webhooks:write) gets back: the customer, and a
 * permission error for anything else.
 */
function onboardingScopedKey(req: StripeApiRequest): Response {
  if (req.method === 'GET' && req.path === `/v1/customers/${CUSTOMER_ID}`) {
    return stripeJson(200, customerJson);
  }
  return stripeError(
    403,
    'invalid_request_error',
    `The provided key does not have the required permissions for this endpoint (${req.path}).`,
  );
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

interface OrgOpts {
  plan?: 'free' | 'starter' | 'growth';
  /** Plaintext restricted key to store encrypted; null for "never connected". */
  apiKey?: string | null;
}

async function seedOrg(opts: OrgOpts = {}): Promise<string> {
  const { plan = 'growth', apiKey = API_KEY } = opts;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations
       (name, plan, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc)
     VALUES ('DB suite org', $1, $2, 'we_db_suite', $3)
     RETURNING id`,
    [plan, apiKey === null ? null : encryptApiKey(apiKey), encryptApiKey(WEBHOOK_SECRET)],
  );
  return rows[0].id;
}

interface SubscriptionOpts {
  id?: string;
  reason?: string | null;
  feedback?: string | null;
}

/** A customer.subscription.deleted payload's data.object. */
function cancelledSubscription(opts: SubscriptionOpts = {}) {
  return {
    id: opts.id ?? `sub_${randomUUID()}`,
    object: 'subscription',
    customer: CUSTOMER_ID,
    status: 'canceled',
    items: {
      object: 'list',
      data: [{ quantity: 1, price: { unit_amount: 2900, recurring: { interval: 'month', interval_count: 1 } } }],
    },
    cancellation_details: {
      reason: opts.reason === undefined ? 'cancellation_requested' : opts.reason,
      feedback: opts.feedback ?? null,
      comment: null,
    },
  };
}

/** Delivers a correctly signed event to the route, as Stripe would. */
async function deliver(
  orgId: string,
  subscription: ReturnType<typeof cancelledSubscription>,
  type = 'customer.subscription.deleted',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type,
    data: { object: subscription },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const res = await POST(
    new NextRequest(`http://localhost/api/webhooks/stripe/${orgId}`, {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: payload,
    }),
    { params: { orgId } },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function surveyRows(orgId: string) {
  const { rows } = await pool().query<{
    stripe_subscription_id: string;
    survey_email_sent_at: Date | null;
    survey_email_attempts: number;
  }>(
    `SELECT stripe_subscription_id, survey_email_sent_at, survey_email_attempts
     FROM survey_responses WHERE org_id = $1 ORDER BY created_at`,
    [orgId],
  );
  return rows;
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('Stripe webhook against a real database', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'survey_responses' AND column_name = 'survey_email_last_attempt_at'`,
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
    // unsubscribes has no FK to organizations any more, so it needs naming.
    await pool().query('TRUNCATE organizations, unsubscribes CASCADE');
    sentEmails.length = 0;
    stripeApi.requests.length = 0;
    stripeApi.respond = onboardingScopedKey;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('surveys a customer who chose to cancel: one row, one email, stamped sent', async () => {
    const orgId = await seedOrg();
    const subscription = cancelledSubscription({ reason: 'cancellation_requested' });

    const res = await deliver(orgId, subscription);

    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(sentEmails.map((e) => e.to)).toEqual([CUSTOMER_EMAIL]);
    const rows = await surveyRows(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_subscription_id).toBe(subscription.id);
    expect(rows[0].survey_email_sent_at).not.toBeNull();
  });

  // ─── Involuntary churn ────────────────────────────────────────────────────

  describe('a subscription Stripe cancelled because payment failed or was disputed', () => {
    it.each(['payment_failed', 'payment_disputed'])(
      'is skipped as involuntary churn when the reason is %s',
      async (reason) => {
        const orgId = await seedOrg();

        const res = await deliver(orgId, cancelledSubscription({ reason }));

        // 200, so Stripe does not retry an event we will never act on.
        expect(res).toEqual({ status: 200, body: { received: true, skipped: 'involuntary_churn' } });
        expect(sentEmails).toEqual([]);
        expect(await surveyRows(orgId)).toEqual([]);
      },
    );

    it('fetches nothing about the customer from Stripe', async () => {
      // Data minimisation: someone we will not survey should not have their
      // email and name pulled into our process at all.
      const orgId = await seedOrg();

      await deliver(orgId, cancelledSubscription({ reason: 'payment_failed' }));

      expect(stripeApi.requests).toEqual([]);
    });

    it('is skipped even when the customer also left portal feedback', async () => {
      // The prefill path records a completed response without emailing; an
      // involuntary cancellation must not leave a row through that door either.
      const orgId = await seedOrg();

      const res = await deliver(
        orgId,
        cancelledSubscription({ reason: 'payment_disputed', feedback: 'too_expensive' }),
      );

      expect(res.body).toEqual({ received: true, skipped: 'involuntary_churn' });
      expect(await surveyRows(orgId)).toEqual([]);
    });

    it('still surveys a cancellation that carries no reason at all', async () => {
      // Accounts on an old default API version deliver no cancellation_details.
      // Absent a reason we cannot call it involuntary, so today's behaviour holds.
      const orgId = await seedOrg();

      const res = await deliver(orgId, cancelledSubscription({ reason: null }));

      expect(res.body).toEqual({ received: true });
      expect(sentEmails).toHaveLength(1);
    });
  });
});
