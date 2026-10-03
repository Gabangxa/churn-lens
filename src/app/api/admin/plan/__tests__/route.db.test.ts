import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { assertThrowawayDatabase } from '../../../../../../e2e/helpers/throwaway-db';

/**
 * POST /api/admin/plan against a real PostgreSQL.
 *
 * A comp is one input to the same recompute the Polar webhook runs, so what
 * matters is the plan the org ends up on once its subscriptions are taken into
 * account — which only the real SQL can show. Auth is the real CRON_SECRET
 * check. Skipped unless TEST_DATABASE_URL points at a migrated throwaway
 * database; it TRUNCATEs organizations between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const dbState = vi.hoisted(() => ({ pool: null as Pool | null }));
function pool(): Pool {
  if (!dbState.pool) throw new Error('test pool not initialised');
  return dbState.pool;
}

// withTransaction mirrors src/lib/db.ts, so the route's org row lock is real.
vi.mock('@/lib/db', () => ({
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
// Real: a held recompute reports. ALERT_EMAIL is pinned empty for every suite
// (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const CRON_SECRET = 'admin-plan-db-suite-secret';
const STARTER = 'prod_starter_admin_suite';
const GROWTH = 'prod_growth_admin_suite';

async function setPlan(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new Request('http://localhost/api/admin/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CRON_SECRET}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function seedOrg(): Promise<string> {
  const { rows } = await pool().query(`INSERT INTO organizations (name) VALUES ('admin-plan-db-suite') RETURNING id`);
  return rows[0].id as string;
}

/** A subscription as the webhook would have recorded it, and the plan it would have written. */
async function seedSubscription(orgId: string, id: string, status: string, productId: string, plan: string) {
  await pool().query(
    `INSERT INTO polar_subscriptions (id, org_id, status, product_id, modified_at)
     VALUES ($1, $2, $3, $4, '2026-08-01T00:00:00Z')`,
    [id, orgId, status, productId],
  );
  await pool().query(`UPDATE organizations SET plan = $2, polar_subscription_id = $3 WHERE id = $1`, [
    orgId,
    plan,
    id,
  ]);
}

async function planOf(orgId: string): Promise<{ plan: string; comp_plan: string | null }> {
  const { rows } = await pool().query(`SELECT plan, comp_plan FROM organizations WHERE id = $1`, [orgId]);
  return rows[0];
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/admin/plan against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'comp_plan'`,
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
    vi.stubEnv('CRON_SECRET', CRON_SECRET);
    vi.stubEnv('POLAR_PRODUCT_STARTER', STARTER);
    vi.stubEnv('POLAR_PRODUCT_GROWTH', GROWTH);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetErrorReports();
    await pool().query('TRUNCATE organizations CASCADE');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['starter', 'growth'] as const)('comps a free org onto %s', async (plan) => {
    const org = await seedOrg();

    const res = await setPlan({ orgId: org, plan });

    expect(res).toEqual({ status: 200, body: { orgId: org, compPlan: plan, plan } });
    expect(await planOf(org)).toEqual({ plan, comp_plan: plan });
  });

  it.each([
    ['free', 'free'],
    ['null', null],
  ])('clears the comp when the plan is %s', async (_label, plan) => {
    const org = await seedOrg();
    await setPlan({ orgId: org, plan: 'growth' });

    const res = await setPlan({ orgId: org, plan });

    expect(res).toEqual({ status: 200, body: { orgId: org, compPlan: null, plan: 'free' } });
    expect(await planOf(org)).toEqual({ plan: 'free', comp_plan: null });
  });

  it('leaves a paying org on its subscription’s tier when the comp is cleared', async () => {
    // 'free' used to force the plan to free; a comp cannot take away what a
    // subscription is paying for.
    const org = await seedOrg();
    await seedSubscription(org, 'sub_paying', 'active', STARTER, 'starter');
    await setPlan({ orgId: org, plan: 'growth' });

    const res = await setPlan({ orgId: org, plan: 'free' });

    expect(res.body).toEqual({ orgId: org, compPlan: null, plan: 'starter' });
  });

  it('keeps a subscription’s higher tier over a lower comp', async () => {
    const org = await seedOrg();
    await seedSubscription(org, 'sub_paying', 'active', GROWTH, 'growth');

    const res = await setPlan({ orgId: org, plan: 'starter' });

    expect(res.body).toEqual({ orgId: org, compPlan: 'starter', plan: 'growth' });
    expect(await planOf(org)).toEqual({ plan: 'growth', comp_plan: 'starter' });
  });

  it('lifts an ex-subscriber whose subscription has ended', async () => {
    const org = await seedOrg();
    await seedSubscription(org, 'sub_ended', 'canceled', GROWTH, 'free');

    const res = await setPlan({ orgId: org, plan: 'starter' });

    expect(res.body).toEqual({ orgId: org, compPlan: 'starter', plan: 'starter' });
  });

  it('says the plan is held when removing a comp would lower it past an unledgered subscription', async () => {
    // The org's pointer names a subscription that ended long ago under an
    // older build, which wrote no ledger row. The recompute cannot see that it
    // ended, so it will not lower the plan past it, and without `held` in the
    // response the operator would see the comp gone and the plan unchanged.
    const org = await seedOrg();
    await pool().query(`UPDATE organizations SET polar_subscription_id = 'sub_legacy_ended' WHERE id = $1`, [org]);
    await setPlan({ orgId: org, plan: 'growth' });

    const res = await setPlan({ orgId: org, plan: null });

    expect(res).toEqual({
      status: 200,
      body: { orgId: org, compPlan: null, plan: 'growth', held: 'missing_ledger_row' },
    });
    expect(await planOf(org)).toEqual({ plan: 'growth', comp_plan: null });
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'billing.recompute',
        meta: { orgId: org, subscriptionId: 'sub_legacy_ended', step: 'missing_ledger_row' },
      }),
    ]);

    // The release README documents for a subscription known to have ended.
    await pool().query(`UPDATE organizations SET polar_subscription_id = NULL WHERE id = $1`, [org]);
    const released = await setPlan({ orgId: org, plan: null });

    expect(released.body).toEqual({ orgId: org, compPlan: null, plan: 'free' });
  });

  it('releases the hold once the subscription’s ledger row is added from Polar', async () => {
    const org = await seedOrg();
    await pool().query(`UPDATE organizations SET polar_subscription_id = 'sub_legacy_ended' WHERE id = $1`, [org]);
    await setPlan({ orgId: org, plan: 'growth' });
    expect((await setPlan({ orgId: org, plan: null })).body).toMatchObject({ held: 'missing_ledger_row' });

    // The other release README documents: the row as Polar reports it.
    await pool().query(
      `INSERT INTO polar_subscriptions (id, org_id, status, product_id, modified_at)
       VALUES ('sub_legacy_ended', $1, 'canceled', $2, '2026-06-01T00:00:00Z')`,
      [org, GROWTH],
    );
    const released = await setPlan({ orgId: org, plan: null });

    expect(released.body).toEqual({ orgId: org, compPlan: null, plan: 'free' });
  });

  it('returns 404 for an org that does not exist', async () => {
    const res = await setPlan({ orgId: randomUUID(), plan: 'starter' });

    expect(res.status).toBe(404);
  });
});
