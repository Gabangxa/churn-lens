import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { assertThrowawayDatabase } from '../../../e2e/helpers/throwaway-db';

/**
 * disconnectStripe against a real PostgreSQL and the real Stripe SDK.
 *
 * stripe-disconnect.test.ts pins the Stripe calls and the error reporting with
 * the database stubbed. This suite checks what a disconnect leaves in the
 * organizations row — which is what the dashboard, the survey copy and the
 * next connect read — so it is asserted on the row.
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

vi.mock('stripe', async (importOriginal) => {
  const { stripeModuleOverFakeApi } = await import('@/__tests__/helpers/fake-stripe-api');
  return stripeModuleOverFakeApi(await importOriginal<typeof import('stripe')>());
});

import { disconnectStripe } from '../stripe-disconnect';
import { encryptApiKey } from '@/lib/crypto';
import { fakeStripeApi, stripeJson } from '@/__tests__/helpers/fake-stripe-api';

const ENCRYPTION_KEY = 'e'.repeat(64);

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('disconnectStripe against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
  });

  afterAll(async () => {
    await dbState.pool?.end();
    dbState.pool = null;
  });

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', ENCRYPTION_KEY);
    await pool().query('TRUNCATE organizations CASCADE');
    fakeStripeApi.reset((req) =>
      stripeJson(200, { id: req.path.split('/').pop(), object: 'webhook_endpoint', deleted: true }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves nothing behind that described the disconnected Stripe account', async () => {
    // Everything a connect and the webhook write about the connected account:
    // its credentials, the name read from it, and the record that Stripe had
    // rejected its key. A stale name would go on naming that business in
    // survey copy (and keep the dashboard from asking for one); a stale flag
    // would describe a key that is no longer stored.
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO organizations
         (name, stripe_api_key_enc, stripe_webhook_id, stripe_webhook_secret_enc,
          stripe_business_name, stripe_key_invalid_at)
       VALUES ('Disconnect suite org', $1, 'we_registered', $2, 'Acme Analytics', now())
       RETURNING id`,
      [encryptApiKey('rk_live_disconnect_suite'), encryptApiKey('whsec_disconnect_suite')],
    );
    const orgId = rows[0].id;

    await disconnectStripe(orgId);

    const { rows: after } = await pool().query(
      `SELECT stripe_api_key_enc, stripe_account_id, stripe_webhook_id, stripe_webhook_secret_enc,
              stripe_business_name, stripe_key_invalid_at
       FROM organizations WHERE id = $1`,
      [orgId],
    );
    expect(after[0]).toEqual({
      stripe_api_key_enc: null,
      stripe_account_id: null,
      stripe_webhook_id: null,
      stripe_webhook_secret_enc: null,
      stripe_business_name: null,
      stripe_key_invalid_at: null,
    });
    // And the endpoint ChurnLens registered was removed with the stored key.
    expect(fakeStripeApi.requests).toEqual([
      { method: 'DELETE', path: '/v1/webhook_endpoints/we_registered', apiKey: 'rk_live_disconnect_suite' },
    ]);
  });
});
