import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHmac, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { assertThrowawayDatabase } from '../../../../../../e2e/helpers/throwaway-db';

/**
 * The Polar webhook against a real PostgreSQL, fed real signed payloads.
 *
 * route.test.ts mocks validateEvent and execute, so it can say which statement
 * the route emits but not what that statement does to a row — and everything
 * that matters here (the out-of-order watermark, which subscription a revoke
 * may touch, two deliveries racing for one row) lives in the UPDATE's WHERE
 * clause. Nothing on the request path is mocked except the pool, which this
 * file owns so it can close it: the SDK's own validateEvent verifies the
 * signature and parses the payload exactly as it does in production.
 *
 * Same contract as src/app/api/purge/__tests__/route.db.test.ts: skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database, which CI provisions.
 * It TRUNCATEs organizations between tests.
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

import { POST } from '../route';

const SECRET = 'polar_whs_db_suite_secret';
const STARTER = 'prod_starter_db_suite';
const GROWTH = 'prod_growth_db_suite';

/** Midnight UTC on the given day of August 2026 — the suite's timeline. */
function aug(day: number): Date {
  return new Date(Date.UTC(2026, 7, day));
}

/**
 * Two subscriptions for one org: A is the one it started on, B the one it
 * moves to. B is created after A, as Polar would create it.
 */
const SUB_A = { id: 'sub_A', productId: STARTER, createdAt: aug(1) };
const SUB_B = { id: 'sub_B', productId: GROWTH, createdAt: aug(10) };
type Sub = typeof SUB_A;

interface EventSpec {
  type: string;
  status: string;
  modifiedAt: Date;
  /** Overrides the subscription's product, e.g. a plan change made in the portal. */
  productId?: string;
}

/**
 * A subscription webhook body in Polar's wire format (snake_case), carrying
 * every field the SDK's inbound schema requires. Values the route never reads
 * are fixed placeholders; none of them is personal data.
 */
function subscriptionPayload(orgId: string, sub: Sub, spec: EventSpec): string {
  const iso = (d: Date) => d.toISOString();
  const productId = spec.productId ?? sub.productId;
  return JSON.stringify({
    type: spec.type,
    timestamp: iso(spec.modifiedAt),
    data: {
      created_at: iso(sub.createdAt),
      modified_at: iso(spec.modifiedAt),
      id: sub.id,
      amount: 1900,
      currency: 'usd',
      recurring_interval: 'month',
      recurring_interval_count: 1,
      status: spec.status,
      current_period_start: iso(sub.createdAt),
      current_period_end: iso(aug(31)),
      current_meter_period_start: null,
      current_meter_period_end: null,
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      started_at: iso(sub.createdAt),
      ends_at: null,
      ended_at: null,
      pause_at_period_end: false,
      paused_at: null,
      resumes_at: null,
      customer_id: 'cus_db_suite',
      product_id: productId,
      discount_id: null,
      checkout_id: null,
      customer_cancellation_reason: null,
      customer_cancellation_comment: null,
      metadata: {},
      customer: {
        id: 'cus_db_suite',
        created_at: iso(aug(1)),
        modified_at: null,
        metadata: {},
        external_id: orgId,
        email_verified: false,
        type: 'individual',
        name: null,
        billing_name: null,
        billing_address: null,
        tax_id: null,
        organization_id: 'polar_org_db_suite',
        deleted_at: null,
        avatar_url: 'https://example.com/avatar.png',
      },
      product: {
        id: productId,
        created_at: iso(aug(1)),
        modified_at: null,
        trial_interval: null,
        trial_interval_count: null,
        name: 'Plan',
        description: null,
        visibility: 'public',
        recurring_interval: 'month',
        recurring_interval_count: 1,
        meter_interval: 'month',
        meter_interval_count: 1,
        is_recurring: true,
        is_archived: false,
        organization_id: 'polar_org_db_suite',
        metadata: {},
        prices: [],
        benefits: [],
        medias: [],
        attached_custom_fields: [],
      },
      discount: null,
      prices: [],
      meters: [],
      pending_update: null,
    },
  });
}

/**
 * A delivery signed the way Polar signs it (Standard Webhooks, v1):
 * base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<body>")).
 *
 * The key is the secret's raw UTF-8 bytes. The SDK's validateEvent
 * base64-encodes the configured secret before handing it to standard-webhooks,
 * which decodes it again, so that is what a correct signature must use — and
 * the "different secret" test below proves the route really checks it.
 */
function signedDelivery(body: string, secret = SECRET): Request {
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret, 'utf-8'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return new Request('http://localhost/api/webhooks/polar', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
    body,
  });
}

async function deliver(
  orgId: string,
  sub: Sub,
  spec: EventSpec,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(signedDelivery(subscriptionPayload(orgId, sub, spec)));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Shorthands for the events the timelines below are made of.
const active = (modifiedAt: Date, productId?: string): EventSpec => ({
  type: 'subscription.active',
  status: 'active',
  modifiedAt,
  productId,
});
const renewed = (modifiedAt: Date): EventSpec => ({
  type: 'subscription.updated',
  status: 'active',
  modifiedAt,
});
const revoked = (modifiedAt: Date): EventSpec => ({
  type: 'subscription.revoked',
  status: 'canceled',
  modifiedAt,
});

async function seedOrg(): Promise<string> {
  const { rows } = await pool().query(
    `INSERT INTO organizations (name) VALUES ('polar-db-suite') RETURNING id`,
  );
  return rows[0].id as string;
}

interface OrgBilling {
  plan: string;
  polar_subscription_id: string | null;
  polar_synced_at: Date | null;
}

async function billing(orgId: string): Promise<OrgBilling> {
  const { rows } = await pool().query(
    `SELECT plan, polar_subscription_id, polar_synced_at FROM organizations WHERE id = $1`,
    [orgId],
  );
  return rows[0] as OrgBilling;
}

/** Polls until a backend in this database is waiting on a lock inside the webhook's UPDATE. */
async function waitForBlockedWebhookUpdate(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await pool().query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query LIKE 'UPDATE organizations%'`,
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the webhook UPDATE never blocked on the held row lock');
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/webhooks/polar against a real database', () => {
  beforeAll(async () => {
    // Before the first connection, let alone the TRUNCATE in beforeEach.
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'polar_synced_at'`,
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
    vi.stubEnv('POLAR_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('POLAR_PRODUCT_STARTER', STARTER);
    vi.stubEnv('POLAR_PRODUCT_GROWTH', GROWTH);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Cascades to every table that references organizations.
    await pool().query('TRUNCATE organizations CASCADE');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('signature contract', () => {
    it('applies a delivery signed the way Polar signs it', async () => {
      const org = await seedOrg();

      const res = await deliver(org, SUB_A, active(aug(2)));

      expect(res).toEqual({ status: 200, body: { received: true, orgId: org, plan: 'starter' } });
      expect(await billing(org)).toEqual({
        plan: 'starter',
        polar_subscription_id: 'sub_A',
        polar_synced_at: aug(2),
      });
    });

    it('rejects a delivery signed with another secret and writes nothing', async () => {
      const org = await seedOrg();
      const body = subscriptionPayload(org, SUB_A, active(aug(2)));

      const res = await POST(signedDelivery(body, 'polar_whs_someone_else'));

      expect(res.status).toBe(403);
      expect(await billing(org)).toEqual({
        plan: 'free',
        polar_subscription_id: null,
        polar_synced_at: null,
      });
    });
  });

  describe('a revoke only counts for the org’s current subscription', () => {
    it('ignores the old subscription ending after the org moved to a new one', async () => {
      // The reported defect: the org paid for B, then A's revocation dropped it
      // to free.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      const res = await deliver(org, SUB_A, revoked(aug(15)));

      expect(res).toEqual({
        status: 200,
        body: { received: true, skipped: 'not_current_subscription' },
      });
      expect(await billing(org)).toEqual({
        plan: 'growth',
        polar_subscription_id: 'sub_B',
        polar_synced_at: aug(11),
      });
    });

    it('downgrades when the current subscription is revoked', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));

      const res = await deliver(org, SUB_A, revoked(aug(5)));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'free' });
      expect(await billing(org)).toEqual({
        plan: 'free',
        polar_subscription_id: 'sub_A',
        polar_synced_at: aug(5),
      });
    });

    it('still downgrades when the new subscription itself is revoked', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      await deliver(org, SUB_B, revoked(aug(20)));

      expect(await billing(org)).toMatchObject({ plan: 'free', polar_subscription_id: 'sub_B' });
    });

    it('applies a revoke when no subscription is recorded, so that subscription’s delayed grant stays dead', async () => {
      // If this revoke were skipped for want of a current subscription, nothing
      // would set the watermark, and the grant that Polar sent first but
      // delivered last would hand out a paid plan for a revoked subscription.
      const org = await seedOrg();

      const revoke = await deliver(org, SUB_A, revoked(aug(5)));
      const lateGrant = await deliver(org, SUB_A, active(aug(2)));

      expect(revoke.body).toEqual({ received: true, orgId: org, plan: 'free' });
      expect(lateGrant.body).toEqual({ received: true, skipped: 'stale_or_unknown_org' });
      expect(await billing(org)).toEqual({
        plan: 'free',
        polar_subscription_id: 'sub_A',
        polar_synced_at: aug(5),
      });
    });

    it('acknowledges a revoke for an org that does not exist', async () => {
      const res = await deliver(randomUUID(), SUB_A, revoked(aug(5)));

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'stale_or_unknown_org' } });
    });
  });

  describe('out-of-order delivery across subscriptions (the watermark is per org)', () => {
    it('drops a delayed grant from the old subscription once the new one is current', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      const res = await deliver(org, SUB_A, renewed(aug(8)));

      expect(res.body).toEqual({ received: true, skipped: 'stale_or_unknown_org' });
      expect(await billing(org)).toEqual({
        plan: 'growth',
        polar_subscription_id: 'sub_B',
        polar_synced_at: aug(11),
      });
    });

    it('reports a delayed revoke of the old subscription as not current, even when it is also stale', async () => {
      // A ended on the 9th, before B existed, but that event lands last. Either
      // gate alone would refuse it; the reason names the one that always will.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      const res = await deliver(org, SUB_A, revoked(aug(9)));

      expect(res.body).toEqual({ received: true, skipped: 'not_current_subscription' });
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });

    it('lets the new subscription in after the old one ended', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_A, revoked(aug(9)));

      const res = await deliver(org, SUB_B, active(aug(11)));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'growth' });
      expect(await billing(org)).toEqual({
        plan: 'growth',
        polar_subscription_id: 'sub_B',
        polar_synced_at: aug(11),
      });
    });

    it('does not let a skipped revoke move the watermark, so the current subscription’s delayed event still applies', async () => {
      // A's revocation is stamped the 20th; B's downgrade to starter the 15th
      // but delivered after it. Had the skipped revoke advanced the watermark to
      // the 20th, B's real change would be thrown away as stale.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));
      await deliver(org, SUB_A, revoked(aug(20)));

      const res = await deliver(org, SUB_B, active(aug(15), STARTER));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'starter' });
      expect(await billing(org)).toEqual({
        plan: 'starter',
        polar_subscription_id: 'sub_B',
        polar_synced_at: aug(15),
      });
    });
  });

  describe('concurrent deliveries', () => {
    it('re-checks which subscription is current after waiting for a racing grant to commit', async () => {
      // A read-then-write would see A as current, decide the revoke applies,
      // and then overwrite the grant for B that committed in between. With the
      // check in the UPDATE's WHERE, Postgres re-evaluates it against the row
      // version it waited for (READ COMMITTED), so the revoke finds B current.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));

      // Stands in for B's grant mid-flight in another request: same row write,
      // held uncommitted so the webhook's UPDATE has to queue behind it.
      const racer = await pool().connect();
      let committed = false;
      try {
        await racer.query('BEGIN');
        await racer.query(
          `UPDATE organizations
           SET plan = 'growth', polar_subscription_id = 'sub_B', polar_synced_at = $2
           WHERE id = $1`,
          [org, aug(11)],
        );

        const pending = deliver(org, SUB_A, revoked(aug(15)));
        await waitForBlockedWebhookUpdate();
        await racer.query('COMMIT');
        committed = true;

        expect((await pending).body).toEqual({
          received: true,
          skipped: 'not_current_subscription',
        });
      } finally {
        // A failure before COMMIT must not hand a connection that is still
        // inside a transaction (and still holding the row lock) back to the pool.
        if (!committed) await racer.query('ROLLBACK');
        racer.release();
      }
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });
  });

  describe('two subscriptions active at once (the Polar setting is meant to prevent this)', () => {
    it('follows whichever subscription was granted most recently, and ignores the other one ending', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));
      await deliver(org, SUB_A, renewed(aug(14)));

      expect(await billing(org)).toMatchObject({ plan: 'starter', polar_subscription_id: 'sub_A' });

      const res = await deliver(org, SUB_B, revoked(aug(16)));

      expect(res.body).toEqual({ received: true, skipped: 'not_current_subscription' });
      expect(await billing(org)).toMatchObject({ plan: 'starter', polar_subscription_id: 'sub_A' });
    });

    it('drops to free when the current one ends, until the other one’s next event', async () => {
      // One pointer cannot know A is still paying. Accepted on the assumption
      // that Polar's allow_multiple_subscriptions setting is off, so this state
      // never arises; if it does, A's next event (its renewal at the latest)
      // puts the org back on A's plan.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      await deliver(org, SUB_B, revoked(aug(16)));
      expect(await billing(org)).toMatchObject({ plan: 'free', polar_subscription_id: 'sub_B' });

      await deliver(org, SUB_A, renewed(aug(20)));
      expect(await billing(org)).toMatchObject({ plan: 'starter', polar_subscription_id: 'sub_A' });
    });
  });

  describe('accepted gaps of one watermark per org', () => {
    // Both need per-subscription ordering (e.g. storing the current
    // subscription's created_at) to close. They are pinned so that closing them
    // is a deliberate, visible change rather than an accident.

    it('GAP: a new subscription’s grant is dropped as stale if the old one changed after it was created', async () => {
      // A is modified on the 12th, after B was created on the 10th, and that
      // event is delivered before B's grant. Nothing tells the route B is the
      // newer subscription, so B's grant loses to the per-org watermark until
      // B's next event.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_A, revoked(aug(12)));

      const lateGrant = await deliver(org, SUB_B, active(aug(11)));
      expect(lateGrant.body).toEqual({ received: true, skipped: 'stale_or_unknown_org' });
      expect(await billing(org)).toMatchObject({ plan: 'free', polar_subscription_id: 'sub_A' });

      await deliver(org, SUB_B, renewed(aug(25)));
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });

    it('GAP: a revoke that overtakes its own subscription’s grant is skipped, and the late grant then applies', async () => {
      // B is granted on the 11th and revoked on the 15th, but the revoke is
      // delivered first, while A is still the current subscription — so it is
      // skipped as not current, and nothing remembers that B has ended.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_A, revoked(aug(5)));

      const earlyRevoke = await deliver(org, SUB_B, revoked(aug(15)));
      expect(earlyRevoke.body).toEqual({ received: true, skipped: 'not_current_subscription' });

      await deliver(org, SUB_B, active(aug(11)));
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });
  });
});
