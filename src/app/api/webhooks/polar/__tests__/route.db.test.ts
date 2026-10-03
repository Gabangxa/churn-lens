import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { assertThrowawayDatabase } from '../../../../../../e2e/helpers/throwaway-db';
import {
  polarEventBody,
  polarSubscriptionJson,
  signedPolarDelivery,
} from '@/__tests__/helpers/polar-fixtures';

/**
 * The Polar webhook against a real PostgreSQL, fed real signed payloads.
 *
 * Everything that decides an org's plan lives in SQL: the per-subscription
 * ledger's ordering (an upsert that only lands when it is newer), the org row
 * lock that serialises two deliveries for one org, and the recompute over every
 * subscription the org has. None of that can be shown against a mock. Nothing
 * on the request path is mocked except the pool, which this file owns so it
 * can close it: the SDK's own validateEvent verifies the signature exactly as
 * it does in production.
 *
 * Same contract as src/app/api/purge/__tests__/route.db.test.ts: skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database, which CI provisions.
 * It TRUNCATEs organizations (and so the ledger) between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const dbState = vi.hoisted(() => ({ pool: null as Pool | null }));
function pool(): Pool {
  if (!dbState.pool) throw new Error('test pool not initialised');
  return dbState.pool;
}

// withTransaction mirrors src/lib/db.ts: one dedicated connection, BEGIN,
// COMMIT, ROLLBACK on any error. The org row lock the route takes only means
// something inside a real transaction, so this is not a pass-through.
vi.mock('@/lib/db', () => ({
  query: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows,
  execute: async (text: string, params?: unknown[]) =>
    (await pool().query(text, params)).rowCount ?? 0,
  queryOne: async (text: string, params?: unknown[]) =>
    (await pool().query(text, params)).rows[0] ?? null,
  withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
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

import { POST } from '../route';
// Real: some tests assert on what the route reported. ALERT_EMAIL is pinned
// empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const SECRET = 'polar_whs_db_suite_secret';
const STARTER = 'prod_starter_db_suite';
const GROWTH = 'prod_growth_db_suite';

/** Midnight UTC on the given day of August 2026 — the suite's timeline. */
function aug(day: number): string {
  return new Date(Date.UTC(2026, 7, day)).toISOString();
}

/**
 * Two subscriptions for one org: A is the one it started on, B a second one,
 * created after A as Polar would create it.
 */
const SUB_A = { id: 'sub_A', productId: STARTER, createdAt: aug(1) };
const SUB_B = { id: 'sub_B', productId: GROWTH, createdAt: aug(10) };
type Sub = typeof SUB_A;

interface EventSpec {
  type: string;
  status: string;
  modifiedAt: string;
  /** Overrides the subscription's product, e.g. a plan change made in the portal. */
  productId?: string;
}

function subscriptionBody(externalId: string | null, sub: Sub, spec: EventSpec): string {
  return polarEventBody(
    spec.type,
    polarSubscriptionJson({
      id: sub.id,
      status: spec.status,
      productId: spec.productId ?? sub.productId,
      externalId,
      createdAt: sub.createdAt,
      modifiedAt: spec.modifiedAt,
    }),
    spec.modifiedAt,
  );
}

async function post(body: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(signedPolarDelivery(body, SECRET));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function deliver(orgId: string, sub: Sub, spec: EventSpec) {
  return post(subscriptionBody(orgId, sub, spec));
}

// Shorthands for the events the timelines below are made of.
const active = (modifiedAt: string, productId?: string): EventSpec => ({
  type: 'subscription.active',
  status: 'active',
  modifiedAt,
  productId,
});
const renewed = (modifiedAt: string): EventSpec => ({
  type: 'subscription.updated',
  status: 'active',
  modifiedAt,
});
const revoked = (modifiedAt: string): EventSpec => ({
  type: 'subscription.revoked',
  status: 'canceled',
  modifiedAt,
});

async function seedOrg(compPlan: 'starter' | 'growth' | null = null): Promise<string> {
  const { rows } = await pool().query(
    `INSERT INTO organizations (name, comp_plan, plan) VALUES ('polar-db-suite', $1, COALESCE($1, 'free'))
     RETURNING id`,
    [compPlan],
  );
  return rows[0].id as string;
}

interface OrgBilling {
  plan: string;
  polar_subscription_id: string | null;
  polar_customer_id: string | null;
}

async function billing(orgId: string): Promise<OrgBilling> {
  const { rows } = await pool().query(
    `SELECT plan, polar_subscription_id, polar_customer_id FROM organizations WHERE id = $1`,
    [orgId],
  );
  return rows[0] as OrgBilling;
}

async function ledger(orgId: string): Promise<Array<{ id: string; status: string; product_id: string }>> {
  const { rows } = await pool().query(
    `SELECT id, status, product_id FROM polar_subscriptions WHERE org_id = $1 ORDER BY id`,
    [orgId],
  );
  return rows;
}

/** Polls until a backend in this database is waiting on a lock inside the webhook's org lock. */
async function waitForBlockedOrgLock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await pool().query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query LIKE 'SELECT 1 FROM organizations%FOR UPDATE%'`,
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the webhook never blocked on the held org row lock');
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/webhooks/polar against a real database', () => {
  beforeAll(async () => {
    // Before the first connection, let alone the TRUNCATE in beforeEach.
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'comp_plan'`,
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
    resetErrorReports();
    // Cascades to every table that references organizations, the ledger included.
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
        polar_customer_id: 'cus_fixture',
      });
      expect(await ledger(org)).toEqual([{ id: 'sub_A', status: 'active', product_id: STARTER }]);
    });

    it('rejects a delivery signed with another secret and writes nothing', async () => {
      const org = await seedOrg();
      const body = subscriptionBody(org, SUB_A, active(aug(2)));

      const res = await POST(signedPolarDelivery(body, 'polar_whs_someone_else'));

      expect(res.status).toBe(403);
      expect(await billing(org)).toEqual({
        plan: 'free',
        polar_subscription_id: null,
        polar_customer_id: null,
      });
      expect(await ledger(org)).toEqual([]);
    });
  });

  describe('entitlement is driven by status, not event type', () => {
    it('does NOT revoke on subscription.canceled while the status is still active', async () => {
      // The customer asked to cancel but has paid through the period end.
      // Revoking here would cut off access they are still owed.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));

      await deliver(org, SUB_A, { type: 'subscription.canceled', status: 'active', modifiedAt: aug(5) });

      expect(await billing(org)).toMatchObject({ plan: 'starter' });
    });

    it('keeps a past_due subscription entitled', async () => {
      // plan.ts: a declined card is retried by Polar before the subscription
      // ends; the terminal status is what revokes.
      const org = await seedOrg();
      await deliver(org, SUB_B, active(aug(11)));

      await deliver(org, SUB_B, { type: 'subscription.past_due', status: 'past_due', modifiedAt: aug(20) });

      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });

    it('keeps the plan through a cancel request and its undo', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_A, { type: 'subscription.canceled', status: 'active', modifiedAt: aug(3) });

      const res = await deliver(org, SUB_A, { type: 'subscription.uncanceled', status: 'active', modifiedAt: aug(4) });

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'starter' });
    });

    it.each(['canceled', 'unpaid', 'incomplete_expired', 'paused'])(
      'drops to free on the terminal status %s',
      async (status) => {
        const org = await seedOrg();
        await deliver(org, SUB_A, active(aug(2)));

        const res = await deliver(org, SUB_A, { type: 'subscription.updated', status, modifiedAt: aug(5) });

        expect(res.body).toEqual({ received: true, orgId: org, plan: 'free' });
        expect(await billing(org)).toMatchObject({ plan: 'free', polar_subscription_id: 'sub_A' });
      },
    );

    it('leaves everything untouched for an incomplete subscription, which has never been paid', async () => {
      const org = await seedOrg();

      const res = await deliver(org, SUB_A, { type: 'subscription.created', status: 'incomplete', modifiedAt: aug(1) });

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'status_incomplete' } });
      expect(await billing(org)).toEqual({ plan: 'free', polar_subscription_id: null, polar_customer_id: null });
      expect(await ledger(org)).toEqual([]);
    });
  });

  describe('refuses to guess a tier', () => {
    it('grants nothing for an unrecognized product, and reports it with the ids needed to fix the mapping', async () => {
      const org = await seedOrg();

      const res = await deliver(org, SUB_A, active(aug(2), 'prod_unknown'));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'free' });
      expect(getErrorReportSnapshot().recent).toEqual([
        expect.objectContaining({
          context: 'webhook.polar',
          meta: { orgId: org, productId: 'prod_unknown', subscriptionId: 'sub_A', step: 'unknown_product' },
        }),
      ]);
      // Recorded all the same, so its next event — or a corrected mapping —
      // starts from what Polar last said about it.
      expect(await ledger(org)).toEqual([{ id: 'sub_A', status: 'active', product_id: 'prod_unknown' }]);
    });

    it('reports an unknown product once, not again on a redelivery of the same event', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2), 'prod_unknown'));

      const again = await deliver(org, SUB_A, active(aug(2), 'prod_unknown'));

      expect(again.body).toEqual({ received: true, skipped: 'stale_event' });
      expect(getErrorReportSnapshot().totalReported).toBe(1);
    });

    it('does not report an unknown product for an org that is not in this database', async () => {
      // A purged org, or another environment's org on a shared Polar
      // organization — whose product ids are not this environment's to map.
      const res = await deliver(randomUUID(), SUB_A, active(aug(2), 'prod_unknown'));

      expect(res.body).toEqual({ received: true, skipped: 'unknown_org' });
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });

    it('still revokes when the product is unknown, and does not report it', async () => {
      // Ending access needs no tier. Failing to revoke would leave a
      // non-paying org on a paid plan.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));

      await deliver(org, SUB_A, { ...revoked(aug(5)), productId: 'prod_unknown' });

      expect(await billing(org)).toMatchObject({ plan: 'free' });
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });
  });

  describe('delivery order does not matter (each subscription is ordered on its own)', () => {
    it('keeps a revoked subscription dead when its own grant arrives after the revoke', async () => {
      // Formerly an accepted gap: B's revoke landed while A was the current
      // subscription, was skipped as not current, and B's late grant then left
      // the org on growth indefinitely.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_A, revoked(aug(5)));

      const earlyRevoke = await deliver(org, SUB_B, revoked(aug(15)));
      const lateGrant = await deliver(org, SUB_B, active(aug(11)));

      expect(earlyRevoke.body).toEqual({ received: true, orgId: org, plan: 'free' });
      expect(lateGrant.body).toEqual({ received: true, skipped: 'stale_event' });
      expect(await billing(org)).toMatchObject({ plan: 'free' });
    });

    it('grants a new subscription even when the old one changed after the new one was created', async () => {
      // Formerly an accepted gap: A's event stamped the 12th raised the org's
      // single watermark past B's grant (the 11th), so the paying subscription
      // sat on free until its next event — up to a year away on annual billing.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_A, revoked(aug(12)));

      const lateGrant = await deliver(org, SUB_B, active(aug(11)));

      expect(lateGrant.body).toEqual({ received: true, orgId: org, plan: 'growth' });
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });

    it('ignores the old subscription ending after the org moved to a new one', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      await deliver(org, SUB_A, revoked(aug(15)));

      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });

    it('drops a delayed grant for a subscription that has since been revoked', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_A, revoked(aug(9)));

      const res = await deliver(org, SUB_A, renewed(aug(8)));

      expect(res.body).toEqual({ received: true, skipped: 'stale_event' });
      expect(await billing(org)).toMatchObject({ plan: 'free' });
    });

    it('applies a revoke for a subscription never seen before, so its delayed grant stays dead', async () => {
      const org = await seedOrg();

      const revoke = await deliver(org, SUB_A, revoked(aug(5)));
      const lateGrant = await deliver(org, SUB_A, active(aug(2)));

      expect(revoke.body).toEqual({ received: true, orgId: org, plan: 'free' });
      expect(lateGrant.body).toEqual({ received: true, skipped: 'stale_event' });
      expect(await billing(org)).toMatchObject({ plan: 'free', polar_subscription_id: 'sub_A' });
    });

    it('lets a subscription’s own later change land after another subscription’s newer event', async () => {
      // The single watermark threw this away: A's revoke stamped the 20th
      // made B's downgrade (the 15th) look stale.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));
      await deliver(org, SUB_A, revoked(aug(20)));

      const res = await deliver(org, SUB_B, active(aug(15), STARTER));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'starter' });
    });

    it('orders two changes in the same millisecond by Polar’s microseconds', async () => {
      // Polar stamps modified_at to the microsecond. A JS Date keeps
      // milliseconds, so passing one through would make these two events
      // equal and drop the second as stale.
      const org = await seedOrg();
      await deliver(org, SUB_A, active('2026-08-02T00:00:00.000100Z'));

      const res = await deliver(org, SUB_A, revoked('2026-08-02T00:00:00.000200Z'));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'free' });

      // ...and the same pair the other way round leaves the revoke standing.
      const other = await seedOrg();
      const otherSub = { ...SUB_B, id: 'sub_B_other' };
      await deliver(other, otherSub, revoked('2026-08-02T00:00:00.000200Z'));
      const stale = await deliver(other, otherSub, active('2026-08-02T00:00:00.000100Z'));

      expect(stale.body).toEqual({ received: true, skipped: 'stale_event' });
      expect(await billing(other)).toMatchObject({ plan: 'free' });
    });

    it('acknowledges a redelivery of the same event without changing anything', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));

      const again = await deliver(org, SUB_A, active(aug(2)));

      expect(again).toEqual({ status: 200, body: { received: true, skipped: 'stale_event' } });
      expect(await billing(org)).toMatchObject({ plan: 'starter', polar_subscription_id: 'sub_A' });
      expect(await ledger(org)).toHaveLength(1);
    });
  });

  describe('two subscriptions active at once', () => {
    it('grants the higher tier whichever was delivered last', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_B, active(aug(11)));

      await deliver(org, SUB_A, renewed(aug(14)));

      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });

    it('falls back to the other subscription when the higher one ends', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      const res = await deliver(org, SUB_B, revoked(aug(16)));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'starter' });
      expect(await billing(org)).toMatchObject({ plan: 'starter', polar_subscription_id: 'sub_A' });
    });

    it('keeps the higher tier when the lower one ends', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));
      await deliver(org, SUB_B, active(aug(11)));

      await deliver(org, SUB_A, revoked(aug(16)));

      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });
  });

  describe('a plan granted through /api/admin/plan (comp_plan)', () => {
    it('survives a checkout that expired before it was paid', async () => {
      // Formerly: incomplete_expired is a revoke status, so it wrote plan =
      // 'free' over the comp.
      const org = await seedOrg('growth');

      await deliver(org, SUB_A, { type: 'subscription.updated', status: 'incomplete_expired', modifiedAt: aug(2) });

      expect(await billing(org)).toMatchObject({ plan: 'growth' });
    });

    it('survives the renewal of a lower-tier subscription', async () => {
      const org = await seedOrg('growth');

      await deliver(org, SUB_A, renewed(aug(3)));

      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_A' });
    });

    it('is what is left when the org’s subscription is revoked', async () => {
      const org = await seedOrg('starter');
      await deliver(org, SUB_B, active(aug(11)));
      expect(await billing(org)).toMatchObject({ plan: 'growth' });

      await deliver(org, SUB_B, revoked(aug(20)));

      expect(await billing(org)).toMatchObject({ plan: 'starter' });
    });
  });

  describe('an org whose subscription is not in the ledger', () => {
    // Paid before polar_subscriptions existed, or during a rollback to the
    // watermark code, which writes the plan and the pointer but no ledger row.
    // The recompute cannot see that subscription, so it must not take away
    // what it may still be paying for.
    const LEGACY = { id: 'sub_legacy', productId: GROWTH, createdAt: aug(1) };

    async function seedUnledgeredOrg(plan: 'free' | 'starter' | 'growth'): Promise<string> {
      const { rows } = await pool().query(
        `INSERT INTO organizations (name, plan, polar_subscription_id)
         VALUES ('polar-db-suite', $1, $2) RETURNING id`,
        [plan, LEGACY.id],
      );
      return rows[0].id as string;
    }

    it('keeps a paid plan another subscription’s event would lower, and reports it for a resync', async () => {
      const org = await seedUnledgeredOrg('growth');

      const res = await deliver(org, SUB_A, revoked(aug(5)));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'growth' });
      // The pointer stays on the unledgered subscription, so the next
      // recompute is held up the same way until it is resynced.
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: LEGACY.id });
      expect(getErrorReportSnapshot().recent).toEqual([
        expect.objectContaining({
          context: 'billing.recompute',
          meta: { orgId: org, subscriptionId: LEGACY.id, step: 'missing_ledger_row' },
        }),
      ]);

      await deliver(org, SUB_A, { type: 'subscription.updated', status: 'canceled', modifiedAt: aug(6) });

      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: LEGACY.id });
    });

    it('still raises the plan, without a report, when the ledger grants more', async () => {
      const org = await seedUnledgeredOrg('starter');

      await deliver(org, SUB_B, active(aug(11)));

      // The pointer stays on the unledgered subscription: moving it to B is
      // what used to end the hold, so B ending later dropped the org to free.
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: LEGACY.id });
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });

    it.each([
      ['the same tier', 'growth'],
      ['a higher tier', 'starter'],
    ] as const)(
      'keeps holding after another subscription grants %s and then ends',
      async (_label, legacyPlan) => {
        // The unledgered subscription may still be paying when B ends. Formerly
        // B's grant took the pointer, B's revoke then saw no unledgered pointer,
        // and the org dropped to free with nothing reported.
        const org = await seedUnledgeredOrg(legacyPlan);
        await deliver(org, SUB_B, active(aug(11)));

        const res = await deliver(org, SUB_B, revoked(aug(20)));

        // Held at the plan the org had: the recompute cannot tell which tier
        // the unledgered subscription pays for, only that it must not lower it.
        expect(res.body).toEqual({ received: true, orgId: org, plan: 'growth' });
        expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: LEGACY.id });
        expect(getErrorReportSnapshot().recent).toEqual([
          expect.objectContaining({
            context: 'billing.recompute',
            meta: { orgId: org, subscriptionId: LEGACY.id, step: 'missing_ledger_row' },
          }),
        ]);
      },
    );

    it('lets the pointer move on once that subscription’s own event lands, ending the hold', async () => {
      const org = await seedUnledgeredOrg('starter');
      await deliver(org, SUB_B, active(aug(11)));

      await deliver(org, LEGACY, revoked(aug(12)));
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: SUB_B.id });

      const res = await deliver(org, SUB_B, revoked(aug(20)));

      expect(res.body).toEqual({ received: true, orgId: org, plan: 'free' });
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });

    it('recomputes normally once that subscription’s own event lands', async () => {
      const org = await seedUnledgeredOrg('growth');

      await deliver(org, LEGACY, revoked(aug(5)));

      expect(await billing(org)).toMatchObject({ plan: 'free', polar_subscription_id: LEGACY.id });
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });

    it('does not report an ex-subscriber on free starting a new subscription', async () => {
      const org = await seedUnledgeredOrg('free');

      await deliver(org, SUB_A, active(aug(5)));

      // The pointer stays put here too: free is only what an older build last
      // wrote, not proof that the unledgered subscription has ended.
      expect(await billing(org)).toMatchObject({ plan: 'starter', polar_subscription_id: LEGACY.id });
      expect(getErrorReportSnapshot().totalReported).toBe(0);
    });
  });

  describe('events the SDK cannot parse', () => {
    // validateEvent verifies the signature first and only then fails to model
    // these types (SDKValidationError). Treating that as a missing secret
    // answered 500 and alerted on every renewal.
    it.each(['subscription.cycled', 'subscription.paused', 'subscription.resumed', 'subscription.migrated'])(
      'applies %s from the verified body',
      async (type) => {
        const org = await seedOrg();

        const res = await post(subscriptionBody(org, SUB_A, { type, status: 'active', modifiedAt: aug(3) }));

        expect(res).toEqual({ status: 200, body: { received: true, orgId: org, plan: 'starter' } });
        expect(getErrorReportSnapshot().totalReported).toBe(0);
      },
    );

    it('acknowledges an event type it does not handle and cannot parse, without reporting it', async () => {
      const org = await seedOrg();

      const res = await post(polarEventBody('customer.brand_new_thing', { id: 'x', external_id: org }));

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'unparsed_event' } });
      expect(getErrorReportSnapshot().totalReported).toBe(0);
      expect(await billing(org)).toMatchObject({ plan: 'free', polar_customer_id: null });
    });

    it('acknowledges a parseable event type it does not handle', async () => {
      const customer = {
        ...(polarSubscriptionJson({
          id: 'unused', status: 'active', productId: STARTER, externalId: randomUUID(), createdAt: aug(1), modifiedAt: null,
        }).customer as Record<string, unknown>),
        // The one field a full Customer has that a subscription's embedded one lacks.
        email: 'customer@example.com',
      };

      const res = await post(polarEventBody('customer.updated', customer));

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'unhandled_event' } });
    });
  });

  describe('attributing the event to an organization', () => {
    it('acknowledges and reports a subscription whose customer external_id is not an org id, naming ids only', async () => {
      // An external_id set outside our checkout (dashboard, import) can be
      // anything — often an email. Cast to uuid by Postgres it threw 22P02, so
      // Polar got ten 500s and dropped the event with nothing reported.
      const res = await post(subscriptionBody('founder-42@acme.example', SUB_A, active(aug(2))));

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'bad_external_id' } });
      const snapshot = getErrorReportSnapshot();
      expect(snapshot.recent).toEqual([
        expect.objectContaining({
          context: 'webhook.polar',
          meta: { subscriptionId: 'sub_A', step: 'bad_external_id' },
        }),
      ]);
      expect(JSON.stringify(snapshot)).not.toContain('founder-42');
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('founder-42');
    });

    it('acknowledges and reports a subscription with no external_id at all', async () => {
      const res = await post(subscriptionBody(null, SUB_A, active(aug(2))));

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'no_external_id' } });
      expect(getErrorReportSnapshot().recent).toEqual([
        expect.objectContaining({ meta: { subscriptionId: 'sub_A', step: 'no_external_id' } }),
      ]);
    });

    it('acknowledges an event for an org that does not exist, and records nothing', async () => {
      const ghost = randomUUID();

      const res = await deliver(ghost, SUB_A, revoked(aug(5)));

      expect(res).toEqual({ status: 200, body: { received: true, skipped: 'unknown_org' } });
      const { rows } = await pool().query(`SELECT count(*)::int AS n FROM polar_subscriptions`);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('concurrent deliveries for one org', () => {
    it('waits for a racing delivery to commit before recomputing, so it cannot overwrite it', async () => {
      // Without the org row lock, A's revoke could read the ledger before B's
      // grant committed, compute free, and write that over B's growth.
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));

      // Stands in for B's grant mid-flight in another request: the same lock,
      // ledger row and plan write, held uncommitted.
      const racer = await pool().connect();
      let committed = false;
      try {
        await racer.query('BEGIN');
        await racer.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [org]);
        await racer.query(
          `INSERT INTO polar_subscriptions (id, org_id, status, product_id, modified_at)
           VALUES ('sub_B', $1, 'active', $2, $3::timestamptz)`,
          [org, GROWTH, aug(11)],
        );
        await racer.query(`UPDATE organizations SET plan = 'growth', polar_subscription_id = 'sub_B' WHERE id = $1`, [org]);

        const pending = deliver(org, SUB_A, revoked(aug(15)));
        await waitForBlockedOrgLock();
        await racer.query('COMMIT');
        committed = true;

        expect((await pending).body).toEqual({ received: true, orgId: org, plan: 'growth' });
      } finally {
        // A failure before COMMIT must not hand a connection that is still
        // inside a transaction (and still holding the row lock) back to the pool.
        if (!committed) await racer.query('ROLLBACK');
        racer.release();
      }
      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });

    it('ends in the right plan when two subscriptions’ events arrive at once', async () => {
      const org = await seedOrg();
      await deliver(org, SUB_A, active(aug(2)));

      await Promise.all([deliver(org, SUB_B, active(aug(11))), deliver(org, SUB_A, revoked(aug(15)))]);

      expect(await billing(org)).toMatchObject({ plan: 'growth', polar_subscription_id: 'sub_B' });
    });
  });
});
