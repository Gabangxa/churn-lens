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

// Stripe's HTTP transport only — see src/__tests__/helpers/fake-stripe-api.ts.
vi.mock('stripe', async (importOriginal) => {
  const { stripeModuleOverFakeApi } = await import('@/__tests__/helpers/fake-stripe-api');
  return stripeModuleOverFakeApi(await importOriginal<typeof import('stripe')>());
});

import { POST } from '../[orgId]/route';
import { encryptApiKey } from '@/lib/crypto';
import { FREE_TIER_MONTHLY_SURVEYS } from '@/lib/plan';
import { countFreeTierSurveys, surveySendStatus } from '@/lib/survey-status';
import {
  fakeStripeApi,
  stripeError,
  stripeJson,
  type FakeStripeRequest,
} from '@/__tests__/helpers/fake-stripe-api';

const ENCRYPTION_KEY = 'c'.repeat(64);
const APP_URL = 'https://app.churnlens.test';
const WEBHOOK_SECRET = 'whsec_db_suite_secret';
const API_KEY = 'rk_live_db_suite_key';
const CUSTOMER_ID = 'cus_jane';
const CUSTOMER_EMAIL = 'jane@example.com';

// ─── Fake Stripe responses ────────────────────────────────────────────────

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
function onboardingScopedKey(req: FakeStripeRequest): Response {
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
  /** SQL interval ago that Stripe first rejected the key, or null (the default). */
  keyInvalidAgo?: string | null;
}

async function seedOrg(opts: OrgOpts = {}): Promise<string> {
  const { plan = 'growth', apiKey = API_KEY, keyInvalidAgo = null } = opts;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations
       (name, plan, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc, stripe_key_invalid_at)
     VALUES ('DB suite org', $1, $2, 'we_db_suite', $3, now() - $4::interval)
     RETURNING id`,
    [plan, apiKey === null ? null : encryptApiKey(apiKey), encryptApiKey(WEBHOOK_SECRET), keyInvalidAgo],
  );
  return rows[0].id;
}

async function keyInvalidAt(orgId: string): Promise<Date | null> {
  const { rows } = await pool().query<{ stripe_key_invalid_at: Date | null }>(
    'SELECT stripe_key_invalid_at FROM organizations WHERE id = $1',
    [orgId],
  );
  return rows[0].stripe_key_invalid_at;
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

interface SurveyRowOpts {
  subscriptionId?: string;
  /** SQL interval ago, or null for "never". */
  sentAgo?: string | null;
  attempts?: number;
  /** SQL interval ago, or null for "never claimed". */
  lastAttemptAgo?: string | null;
  surveyedAgo?: string | null;
}

/** A survey_responses row as the webhook itself would have left it. */
async function seedSurveyRow(orgId: string, opts: SurveyRowOpts = {}): Promise<string> {
  const {
    subscriptionId = `sub_${randomUUID()}`,
    sentAgo = '1 hour',
    attempts = 1,
    lastAttemptAgo = '1 hour',
    surveyedAgo = null,
  } = opts;
  await pool().query(
    `INSERT INTO survey_responses
       (org_id, customer_email, stripe_subscription_id, token, mrr_lost,
        survey_email_sent_at, survey_email_attempts, survey_email_last_attempt_at, surveyed_at)
     VALUES ($1, 'earlier@example.com', $2, $3, 29,
             now() - $4::interval, $5, now() - $6::interval, now() - $7::interval)`,
    [orgId, subscriptionId, `tok_${randomUUID()}`, sentAgo, attempts, lastAttemptAgo, surveyedAgo],
  );
  return subscriptionId;
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
    // unsubscribes has no FK to organizations any more, so it needs naming.
    await pool().query('TRUNCATE organizations, unsubscribes CASCADE');
    sentEmails.length = 0;
    fakeStripeApi.reset(onboardingScopedKey);
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

      expect(fakeStripeApi.requests).toEqual([]);
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

  // ─── Free-tier cap ────────────────────────────────────────────────────────

  describe('a free org at its monthly cap', () => {
    /** A free org that has already sent FREE_TIER_MONTHLY_SURVEYS surveys this month. */
    async function orgAtCap(): Promise<{ orgId: string; earlierSubscriptionIds: string[] }> {
      const orgId = await seedOrg({ plan: 'free' });
      const earlierSubscriptionIds: string[] = [];
      for (let i = 0; i < FREE_TIER_MONTHLY_SURVEYS; i++) {
        earlierSubscriptionIds.push(await seedSurveyRow(orgId));
      }
      return { orgId, earlierSubscriptionIds };
    }

    it('refuses a NEW cancellation without fetching the customer or recording it', async () => {
      const { orgId } = await orgAtCap();

      const res = await deliver(orgId, cancelledSubscription());

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'free_tier_limit' } });
      expect(fakeStripeApi.requests).toEqual([]);
      expect(sentEmails).toEqual([]);
      expect(await surveyRows(orgId)).toHaveLength(FREE_TIER_MONTHLY_SURVEYS);
    });

    it("re-sends Stripe's retry of a send that failed, instead of refusing it as over the cap", async () => {
      // The 10th survey of the month failed to send (Resend down) and 500'd;
      // the row it claimed is what put the org at the cap. Stripe's retry is the
      // second attempt at a survey the org was always entitled to — the cap
      // counts surveys, and this one was already counted.
      const orgId = await seedOrg({ plan: 'free' });
      for (let i = 0; i < FREE_TIER_MONTHLY_SURVEYS - 1; i++) await seedSurveyRow(orgId);
      const stranded = await seedSurveyRow(orgId, {
        sentAgo: null,
        attempts: 1,
        lastAttemptAgo: '10 minutes',
      });

      const res = await deliver(orgId, cancelledSubscription({ id: stranded }));

      expect(res).toEqual({ status: 200, body: { received: true } });
      expect(sentEmails.map((e) => e.to)).toEqual([CUSTOMER_EMAIL]);
      const row = (await surveyRows(orgId)).find((r) => r.stripe_subscription_id === stranded)!;
      expect(row.survey_email_sent_at).not.toBeNull();
      expect(row.survey_email_attempts).toBe(2);
      // A retry adds no row, so it cannot push the org further over.
      expect(await surveyRows(orgId)).toHaveLength(FREE_TIER_MONTHLY_SURVEYS);
    });

    it('reports a redelivery of an already-sent survey as a duplicate, not as the cap', async () => {
      const { orgId, earlierSubscriptionIds } = await orgAtCap();

      const res = await deliver(orgId, cancelledSubscription({ id: earlierSubscriptionIds[0] }));

      expect(res.body).toEqual({ received: true, skipped: 'duplicate_event' });
      expect(sentEmails).toEqual([]);
    });

    it('reports an exhausted send as exhausted, not as the cap', async () => {
      const orgId = await seedOrg({ plan: 'free' });
      for (let i = 0; i < FREE_TIER_MONTHLY_SURVEYS - 1; i++) await seedSurveyRow(orgId);
      const exhausted = await seedSurveyRow(orgId, { sentAgo: null, attempts: 5, lastAttemptAgo: '1 day' });

      const res = await deliver(orgId, cancelledSubscription({ id: exhausted }));

      expect(res.body).toEqual({ received: true, skipped: 'email_send_exhausted' });
    });

    it('reports a redelivered portal-feedback cancellation as a duplicate, not as the cap', async () => {
      const orgId = await seedOrg({ plan: 'free' });
      for (let i = 0; i < FREE_TIER_MONTHLY_SURVEYS - 1; i++) await seedSurveyRow(orgId);
      const prefilled = await seedSurveyRow(orgId, {
        sentAgo: null,
        attempts: 0,
        lastAttemptAgo: null,
        surveyedAgo: '1 hour',
      });

      const res = await deliver(orgId, cancelledSubscription({ id: prefilled, feedback: 'too_expensive' }));

      expect(res.body).toEqual({ received: true, skipped: 'duplicate_event' });
    });

    it("does not let another org's row for the same subscription lift this org's cap", async () => {
      // The "already recorded" test is scoped to this org: another tenant's row
      // must not let a capped org past its cap.
      const { orgId } = await orgAtCap();
      const otherOrgId = await seedOrg({ plan: 'growth' });
      const foreign = await seedSurveyRow(otherOrgId);

      const res = await deliver(orgId, cancelledSubscription({ id: foreign }));

      expect(res.body).toEqual({ received: true, skipped: 'free_tier_limit' });
      expect(fakeStripeApi.requests).toEqual([]);
    });

    it('agrees with the dashboard: the status line reports the cap exactly when new cancellations are refused', async () => {
      const orgId = await seedOrg({ plan: 'free' });
      for (let i = 0; i < FREE_TIER_MONTHLY_SURVEYS - 1; i++) await seedSurveyRow(orgId);
      const statusNow = async () =>
        surveySendStatus({
          stripeConnected: true,
          deletionRequested: false,
          stripeKeyInvalidSince: null,
          legalFooterReady: true,
          plan: 'free',
          surveysThisMonth: await countFreeTierSurveys(orgId),
        }).kind;

      // One under the cap: the dashboard says sending, and the webhook sends.
      expect(await statusNow()).toBe('sending');
      expect((await deliver(orgId, cancelledSubscription())).body).toEqual({ received: true });

      // That send reached the cap: the dashboard says so, and the next NEW one is refused.
      expect(await statusNow()).toBe('free_tier_limit');
      expect((await deliver(orgId, cancelledSubscription())).body).toEqual({
        received: true,
        skipped: 'free_tier_limit',
      });
    });
  });

  // ─── A Stripe key that no longer works ────────────────────────────────────

  describe('when Stripe rejects the stored key', () => {
    // What api.stripe.com answers for a revoked/rolled key (401) and for a
    // restricted key that lost customers:read (403). The SDK maps these by HTTP
    // status, which is exactly what the route has to classify.
    const revokedKey = () =>
      stripeError(401, 'invalid_request_error', 'Expired API Key provided: rk_live_*********************_key');
    const keyLackingPermission = () =>
      stripeError(403, 'invalid_request_error', 'The provided key does not have the required permissions for this endpoint.');

    it.each([
      ['revoked or rolled (401)', revokedKey],
      ['missing a permission it needs (403)', keyLackingPermission],
    ])('answers 200 stripe_key_invalid when the key is %s, so Stripe stops retrying', async (_why, response) => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = response;

      const res = await deliver(orgId, cancelledSubscription());

      // A retry can never succeed until the founder reconnects: a 5xx here was
      // days of Stripe retries, each one failing the same way.
      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'stripe_key_invalid' } });
      expect(sentEmails).toEqual([]);
      expect(await surveyRows(orgId)).toEqual([]);
    });

    it('records on the org when the key was first rejected, for the dashboard to report', async () => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = revokedKey;
      const before = Date.now();

      await deliver(orgId, cancelledSubscription());

      const flaggedAt = await keyInvalidAt(orgId);
      expect(flaggedAt).not.toBeNull();
      expect(flaggedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('keeps the first rejection time on later rejections', async () => {
      const orgId = await seedOrg({ keyInvalidAgo: '2 days' });
      const firstRejectedAt = await keyInvalidAt(orgId);
      fakeStripeApi.respond = revokedKey;

      await deliver(orgId, cancelledSubscription());

      expect(await keyInvalidAt(orgId)).toEqual(firstRejectedAt);
    });

    it('does not flag a key the founder replaced while the rejected request was in flight', async () => {
      // The founder reconnects (new key stored, flag cleared) between this
      // delivery reading the old key and Stripe rejecting it. The rejection is
      // about the old key; flagging the org now would tell the founder to
      // reconnect a key that works.
      const orgId = await seedOrg();
      fakeStripeApi.respond = async () => {
        await pool().query('UPDATE organizations SET stripe_api_key_enc = $1 WHERE id = $2', [
          encryptApiKey('rk_live_replacement_key'),
          orgId,
        ]);
        return revokedKey();
      };

      const res = await deliver(orgId, cancelledSubscription());

      expect(res.body).toEqual({ received: true, skipped: 'stripe_key_invalid' });
      expect(await keyInvalidAt(orgId)).toBeNull();
    });

    it('clears the flag once a call with the stored key succeeds again, and surveys as normal', async () => {
      // e.g. the founder restored the key's permissions in Stripe's dashboard
      // without reconnecting here.
      const orgId = await seedOrg({ keyInvalidAgo: '1 day' });

      const res = await deliver(orgId, cancelledSubscription());

      expect(res.body).toEqual({ received: true });
      expect(sentEmails).toHaveLength(1);
      expect(await keyInvalidAt(orgId)).toBeNull();
    });

    it('logs the org id but never the key', async () => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = revokedKey;

      await deliver(orgId, cancelledSubscription());

      const logged = [...consoleErrorSpy.mock.calls, ...consoleWarnSpy.mock.calls]
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(logged).toContain(orgId);
      expect(logged).not.toContain(API_KEY);
    });
  });

  describe('when Stripe fails transiently', () => {
    it.each([
      ['rate-limits the request (429)', () => stripeError(429, 'invalid_request_error', 'Too many requests.')],
      ['has an internal error (500)', () => stripeError(500, 'api_error', 'Something went wrong on our end.')],
      ['is unavailable (503)', () => stripeError(503, 'api_error', 'Service unavailable.')],
      [
        'cannot be reached at all',
        () => {
          throw new TypeError('fetch failed');
        },
      ],
    ])('still answers 5xx when Stripe %s, so Stripe retries the event', async (_why, response) => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = response;

      const res = await deliver(orgId, cancelledSubscription());

      expect(res.status).toBeGreaterThanOrEqual(500);
      // Nothing is wrong with the key, and nothing was recorded that would
      // turn the retry into a duplicate.
      expect(await keyInvalidAt(orgId)).toBeNull();
      expect(await surveyRows(orgId)).toEqual([]);
      expect(sentEmails).toEqual([]);
    });

    it('surveys the customer on the retry once Stripe recovers', async () => {
      const orgId = await seedOrg();
      const subscription = cancelledSubscription();
      fakeStripeApi.respond = () => stripeError(500, 'api_error', 'Something went wrong on our end.');
      expect((await deliver(orgId, subscription)).status).toBeGreaterThanOrEqual(500);

      fakeStripeApi.respond = onboardingScopedKey;
      const retry = await deliver(orgId, subscription);

      expect(retry.body).toEqual({ received: true });
      expect(sentEmails).toHaveLength(1);
    });
  });
});
