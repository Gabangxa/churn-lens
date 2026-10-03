import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
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
// skip everything as 'legal_footer_unfilled'. Forced ready for every test
// except the ones about that gate, which flip it.
const legalState = vi.hoisted(() => ({ footerReady: true }));
vi.mock('@/lib/legal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/legal')>()),
  legalFooterReady: () => legalState.footerReady,
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
import SurveyPage from '@/app/survey/[token]/page';
import { encryptApiKey } from '@/lib/crypto';
import { FREE_TIER_MONTHLY_SURVEYS } from '@/lib/plan';
// Real: what reaches the operator is asserted on what reportError recorded.
// ALERT_EMAIL is pinned empty for every suite (vitest.config.ts).
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';
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
  /** Settings → survey display name (survey_config.display_name). */
  displayName?: string | null;
  /** organizations.stripe_business_name, as an earlier lookup cached it. */
  stripeBusinessName?: string | null;
}

async function seedOrg(opts: OrgOpts = {}): Promise<string> {
  const {
    plan = 'growth',
    apiKey = API_KEY,
    keyInvalidAgo = null,
    displayName = null,
    stripeBusinessName = null,
  } = opts;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations
       (name, plan, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc,
        stripe_key_invalid_at, survey_config, stripe_business_name)
     VALUES ('DB suite org', $1, $2, 'we_db_suite', $3, now() - $4::interval, $5, $6)
     RETURNING id`,
    [
      plan,
      apiKey === null ? null : encryptApiKey(apiKey),
      encryptApiKey(WEBHOOK_SECRET),
      keyInvalidAgo,
      displayName === null ? null : JSON.stringify({ display_name: displayName }),
      stripeBusinessName,
    ],
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

interface DeliveryOpts {
  type?: string;
  /** Which mode the event comes from. Matches API_KEY (a live key) by default. */
  livemode?: boolean;
  /** The secret the event is signed with — the org's own unless a test forges one. */
  secret?: string;
}

/** Delivers a correctly signed event to the route, as Stripe would. */
async function deliver(
  orgId: string,
  subscription: ReturnType<typeof cancelledSubscription>,
  opts: DeliveryOpts = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { type = 'customer.subscription.deleted', livemode = true, secret = WEBHOOK_SECRET } = opts;
  const payload = JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type,
    livemode,
    data: { object: subscription },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
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
       WHERE table_name = 'organizations' AND column_name = 'stripe_business_name'`,
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
    legalState.footerReady = true;
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

  // ─── An unfilled legal footer ─────────────────────────────────────────────

  describe('while src/lib/legal.ts is unfilled', () => {
    beforeEach(() => {
      legalState.footerReady = false;
      resetErrorReports();
    });

    it('answers a genuine delivery 200, records and fetches nothing, and alerts the operator', async () => {
      const orgId = await seedOrg();

      const res = await deliver(orgId, cancelledSubscription());

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'legal_footer_unfilled' } });
      expect(fakeStripeApi.requests).toEqual([]);
      expect(await surveyRows(orgId)).toEqual([]);
      expect(sentEmails).toEqual([]);
      expect(getErrorReportSnapshot().recent).toEqual([
        expect.objectContaining({ context: 'webhook.stripe', meta: { orgId, step: 'legal_footer' } }),
      ]);
    });

    it('cannot be made to alert the operator by someone who only knows the webhook URL', async () => {
      // The URL is not a secret (it is the org id), so the alert must need a
      // delivery signed with the org's own webhook secret.
      const orgId = await seedOrg();

      const res = await deliver(orgId, cancelledSubscription(), { secret: 'whsec_not_this_orgs' });

      expect(res.status).toBe(400);
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });
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

    it("does not page the operator — the key is the founder's to fix, and their dashboard says so", async () => {
      resetErrorReports();
      const orgId = await seedOrg();
      fakeStripeApi.respond = revokedKey;

      await deliver(orgId, cancelledSubscription());

      expect(getErrorReportSnapshot().totalReported).toBe(0);
      // Still in the logs, as a warning rather than an error.
      const warned = consoleWarnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(warned).toContain(orgId);
      expect(warned).toContain('reconnects Stripe');
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

    it('reports the failed lookup, with the org and subscription, and never the key', async () => {
      resetErrorReports();
      const orgId = await seedOrg();
      const subscription = cancelledSubscription();
      fakeStripeApi.respond = () => stripeError(503, 'api_error', 'Service unavailable.');

      await deliver(orgId, subscription);

      const { recent } = getErrorReportSnapshot();
      expect(recent).toEqual([
        expect.objectContaining({
          context: 'webhook.stripe',
          meta: { orgId, subscriptionId: subscription.id, step: 'customer_lookup' },
        }),
      ]);
      expect(JSON.stringify(recent)).not.toContain(API_KEY);
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

  // ─── Naming the business (POPIA s18) ──────────────────────────────────────

  describe('naming the business the survey is sent for', () => {
    /**
     * A key that can also read the account. Onboarding does NOT ask for this
     * permission (customers:read, subscriptions:read, webhooks:write only), so
     * this is a founder who granted more than required.
     */
    function keyWithAccountRead(account: Record<string, unknown>) {
      return (req: FakeStripeRequest): Response =>
        req.method === 'GET' && req.path === '/v1/account'
          ? stripeJson(200, { id: 'acct_db_suite', object: 'account', ...account })
          : onboardingScopedKey(req);
    }

    /** Fails only the account lookup; the customer lookup still works. */
    function accountLookupFails(failure: () => Response) {
      return (req: FakeStripeRequest): Response =>
        req.path === '/v1/account' ? failure() : onboardingScopedKey(req);
    }

    const accountRequests = () => fakeStripeApi.requests.filter((r) => r.path === '/v1/account');

    async function cachedBusinessName(orgId: string): Promise<string | null> {
      const { rows } = await pool().query<{ stripe_business_name: string | null }>(
        'SELECT stripe_business_name FROM organizations WHERE id = $1',
        [orgId],
      );
      return rows[0].stripe_business_name;
    }

    /** Renders the survey page the emailed link opens, as the customer would see it. */
    async function surveyPageFor(email: CapturedEmail): Promise<string> {
      const token = /\/survey\/(\S+)/.exec(email.text)?.[1];
      if (!token) throw new Error('no survey link in the email');
      return renderToStaticMarkup(await SurveyPage({ params: { token } }));
    }

    it("names the Stripe account's business in the email and on the survey page", async () => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = keyWithAccountRead({
        business_profile: { name: 'Acme Analytics' },
        settings: { dashboard: { display_name: 'acme-internal' } },
      });

      const res = await deliver(orgId, cancelledSubscription());

      expect(res.body).toEqual({ received: true });
      const [email] = sentEmails;
      expect(email.text).toContain('goes directly to the Acme Analytics team');
      expect(email.text).toContain('Thanks,\nThe Acme Analytics team');
      expect(email.text).toContain('Sent on behalf of Acme Analytics by ChurnLens.');
      // The page the link opens names the same business.
      expect(await surveyPageFor(email)).toContain('the Acme Analytics team');
      // Cached, which is how the page (it never calls Stripe) resolves it too.
      expect(await cachedBusinessName(orgId)).toBe('Acme Analytics');
    });

    it("never names the business from the account's dashboard label, which is internal, not public", async () => {
      // settings.dashboard.display_name is what the founder calls the account
      // inside Stripe's dashboard ("Acme TEST", "old-acct-2"); only
      // business_profile.name is meant for customers.
      const orgId = await seedOrg();
      fakeStripeApi.respond = keyWithAccountRead({
        business_profile: { name: null },
        settings: { dashboard: { display_name: 'acme-internal-label' } },
      });

      await deliver(orgId, cancelledSubscription());

      expect(sentEmails[0].text).toContain('Sent on behalf of the business you cancelled with by ChurnLens.');
      expect(sentEmails[0].text).not.toContain('acme-internal-label');
      expect(await cachedBusinessName(orgId)).toBeNull();
    });

    it('does not cache, or email, a name read with a key the founder replaced mid-lookup', async () => {
      // The founder reconnects with another Stripe account's key while this
      // delivery's account lookup (made with the old key) is in flight;
      // connect stores the new key and resets the cached name. The old
      // account's name must not land on the row after that.
      const orgId = await seedOrg();
      fakeStripeApi.respond = async (req) => {
        if (req.path !== '/v1/account') return onboardingScopedKey(req);
        await pool().query(
          'UPDATE organizations SET stripe_api_key_enc = $1, stripe_business_name = NULL WHERE id = $2',
          [encryptApiKey('rk_live_other_account_key'), orgId],
        );
        return stripeJson(200, { id: 'acct_old', object: 'account', business_profile: { name: 'Old Account Ltd' } });
      };

      const res = await deliver(orgId, cancelledSubscription());

      expect(res.body).toEqual({ received: true });
      expect(await cachedBusinessName(orgId)).toBeNull();
      // Not in the email either: the survey page could not have named it.
      expect(sentEmails[0].text).not.toContain('Old Account Ltd');
    });

    it('uses the configured display name first, without asking Stripe for the account at all', async () => {
      const orgId = await seedOrg({ displayName: 'Acme Configured', stripeBusinessName: 'Acme Cached' });
      fakeStripeApi.respond = keyWithAccountRead({ business_profile: { name: 'Acme From Stripe' } });

      await deliver(orgId, cancelledSubscription());

      expect(sentEmails[0].text).toContain('Sent on behalf of Acme Configured by ChurnLens.');
      expect(await surveyPageFor(sentEmails[0])).toContain('the Acme Configured team');
      expect(accountRequests()).toEqual([]);
    });

    it('uses a cached account name without asking Stripe again', async () => {
      const orgId = await seedOrg({ stripeBusinessName: 'Acme Cached' });

      await deliver(orgId, cancelledSubscription());

      expect(sentEmails[0].text).toContain('Sent on behalf of Acme Cached by ChurnLens.');
      expect(await surveyPageFor(sentEmails[0])).toContain('the Acme Cached team');
      expect(accountRequests()).toEqual([]);
    });

    it.each([
      [
        'is not permitted to read the account (403 — the onboarding-scoped default)',
        () => stripeError(403, 'invalid_request_error', 'The provided key does not have the required permissions.'),
      ],
      ['is rejected outright (401)', () => stripeError(401, 'invalid_request_error', 'Invalid API Key provided.')],
      ['meets a Stripe outage (500)', () => stripeError(500, 'api_error', 'Something went wrong on our end.')],
      [
        'cannot reach Stripe',
        () => {
          throw new TypeError('fetch failed');
        },
      ],
    ])('still surveys, with the generic copy, when the account lookup %s', async (_why, failure) => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = accountLookupFails(failure);

      const res = await deliver(orgId, cancelledSubscription());

      expect(res).toEqual({ status: 200, body: { received: true } });
      const [email] = sentEmails;
      // Exactly today's zero-config wording.
      expect(email.text).toContain('goes directly to the founder (not a support queue)');
      expect(email.text).toContain('Thanks,\nThe team');
      expect(email.text).toContain('Sent on behalf of the business you cancelled with by ChurnLens.');
      expect(await surveyPageFor(email)).toContain('goes straight to the founder');
      expect(await cachedBusinessName(orgId)).toBeNull();
    });

    it('never marks the key invalid over the account lookup — only the customer lookup can', async () => {
      // The account read is a permission onboarding never asked for, so a 401
      // or 403 there says nothing about whether surveys can be sent.
      const orgId = await seedOrg();
      fakeStripeApi.respond = accountLookupFails(() =>
        stripeError(401, 'invalid_request_error', 'Invalid API Key provided.'),
      );

      await deliver(orgId, cancelledSubscription());

      expect(await keyInvalidAt(orgId)).toBeNull();
    });

    it('keeps a hostile account name on its one line of the email', async () => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = keyWithAccountRead({
        business_profile: { name: 'Acme\r\n\r\nUnsubscribe here: https://evil.example' },
      });

      await deliver(orgId, cancelledSubscription());

      const lines = sentEmails[0].text.split('\n');
      expect(lines).toContain('Sent on behalf of AcmeUnsubscribe here: https://evil.example by ChurnLens.');
      expect(lines.some((line) => line.startsWith('Unsubscribe here'))).toBe(false);
    });

    it('uses the generic copy rather than cutting off a name too long for it', async () => {
      const orgId = await seedOrg();
      fakeStripeApi.respond = keyWithAccountRead({ business_profile: { name: 'A'.repeat(61) } });

      await deliver(orgId, cancelledSubscription());

      expect(sentEmails[0].text).toContain('Sent on behalf of the business you cancelled with by ChurnLens.');
    });

    it('does not look the account up for a cancellation it will not email', async () => {
      // The portal-prefill path records the answer without sending anything.
      const orgId = await seedOrg();
      fakeStripeApi.respond = keyWithAccountRead({ business_profile: { name: 'Acme Analytics' } });

      await deliver(orgId, cancelledSubscription({ feedback: 'too_expensive' }));

      expect(sentEmails).toEqual([]);
      expect(accountRequests()).toEqual([]);
    });
  });
});
