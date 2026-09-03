import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';

/**
 * Purge SQL against a real PostgreSQL.
 *
 * route.test.ts asserts the statements this route *emits*; it cannot tell you
 * what they do to rows. Retention and erasure are promises to data subjects,
 * and the interesting parts of them are interval arithmetic and a correlated
 * NOT EXISTS — exactly the things a mocked `execute` will happily accept while
 * they are wrong. So these run the real route body against a real engine.
 *
 * Skipped unless TEST_DATABASE_URL points at a throwaway database that
 * `node scripts/migrate.js` has already been run against, e.g.:
 *
 *   docker run -d --name cl-test-pg -e POSTGRES_PASSWORD=pw \
 *     -e POSTGRES_DB=churnlens_test -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL='postgresql://postgres:pw@127.0.0.1:55432/churnlens_test' \
 *     node scripts/migrate.js
 *   TEST_DATABASE_URL='postgresql://postgres:pw@127.0.0.1:55432/churnlens_test' \
 *     npx vitest run src/app/api/purge
 *
 * It TRUNCATEs organizations and unsubscribes between tests. Never point it at
 * a database you care about.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The pool is owned by this file (rather than letting src/lib/db.ts create its
// own module-private one) purely so it can be closed in afterAll — an open pool
// keeps the vitest worker alive. The three helpers below are the whole of
// db.ts's query/execute/queryOne, so the route still runs its own SQL unaltered.
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

vi.mock('@/lib/auth', () => ({ verifyCronSecret: () => true }));

const DATE_STR = '2026-09-01';
vi.mock('@/lib/cron', () => ({
  claimCronRun: async () => true,
  finishCronRun: async () => undefined,
  todayDateStr: () => DATE_STR,
}));

// The org hard-delete's Stripe teardown is a network call; it has its own unit
// test (src/lib/__tests__/stripe-disconnect.test.ts). Here it is a no-op so the
// DELETE it precedes is what gets measured.
vi.mock('@/lib/stripe-disconnect', () => ({ disconnectStripe: async () => undefined }));

import { POST } from '../route';

function purgeRequest() {
  return new Request('http://localhost/api/purge', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
  });
}

interface PurgeResult {
  responses: number;
  themes: number;
  tokens: number;
  orgsDeleted: number;
  abandonedDeleted: number;
  failed: string[];
}

async function runPurge(): Promise<PurgeResult> {
  const res = await POST(purgeRequest());
  const body = (await res.json()) as PurgeResult;
  expect(body.failed).toEqual([]);
  return body;
}

interface OrgOpts {
  createdAt?: string;
  deletionRequestedAt?: string | null;
  stripeApiKeyEnc?: string | null;
  polarSubscriptionId?: string | null;
  plan?: string;
}

/** Seeds one org. Ages are SQL interval expressions, e.g. "31 days", "25 months". */
async function seedOrg(name: string, opts: OrgOpts = {}): Promise<string> {
  const {
    createdAt = '1 day',
    deletionRequestedAt = null,
    stripeApiKeyEnc = null,
    polarSubscriptionId = null,
    plan = 'free',
  } = opts;
  const { rows } = await pool().query(
    `INSERT INTO organizations
       (name, created_at, deletion_requested_at, stripe_api_key_enc, polar_subscription_id, plan)
     VALUES ($1, now() - $2::interval, $3, $4, $5, $6)
     RETURNING id`,
    [
      name,
      createdAt,
      deletionRequestedAt === null ? null : new Date(Date.now() - intervalToMs(deletionRequestedAt)),
      stripeApiKeyEnc,
      polarSubscriptionId,
      plan,
    ],
  );
  return rows[0].id as string;
}

/** Only handles the "<n> days" form the deletion-window cases need. */
function intervalToMs(interval: string): number {
  const match = /^(\d+) days$/.exec(interval);
  if (!match) throw new Error(`unsupported interval in test fixture: ${interval}`);
  return Number(match[1]) * 24 * 60 * 60 * 1000;
}

async function seedResponse(orgId: string, subId: string, ageInterval: string): Promise<void> {
  await pool().query(
    `INSERT INTO survey_responses (org_id, customer_email, stripe_subscription_id, created_at)
     VALUES ($1, $2, $3, now() - $4::interval)`,
    [orgId, `${subId}@example.com`, subId, ageInterval],
  );
}

async function seedTheme(orgId: string, label: string, weekAgoInterval: string): Promise<void> {
  await pool().query(
    `INSERT INTO themes (org_id, week_of, label)
     VALUES ($1, (now() - $2::interval)::date, $3)`,
    [orgId, weekAgoInterval, label],
  );
}

async function seedLoginToken(
  orgId: string,
  hash: string,
  opts: { expiresIn?: string; expiredFor?: string; used?: boolean },
): Promise<void> {
  const { expiresIn, expiredFor, used } = opts;
  await pool().query(
    `INSERT INTO login_tokens (token_hash, org_id, email, expires_at, used_at)
     VALUES ($1, $2, 'founder@example.com',
             ${expiresIn ? `now() + $3::interval` : `now() - $3::interval`},
             ${used ? 'now()' : 'NULL'})`,
    [hash, orgId, expiresIn ?? expiredFor],
  );
}

async function surviving(table: string): Promise<string[]> {
  const column = table === 'organizations' ? 'name' : table === 'themes' ? 'label' : 'customer_email';
  const { rows } = await pool().query(`SELECT ${column} AS v FROM ${table} ORDER BY 1`);
  return rows.map((r) => r.v as string);
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/purge against a real database', () => {
  beforeAll(async () => {
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'deletion_requested_at'`,
    );
    if (rows.length === 0) {
      throw new Error(
        'TEST_DATABASE_URL is not migrated — run `node scripts/migrate.js` against it first.',
      );
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(async () => {
    await dbState.pool?.end();
    dbState.pool = null;
  });

  beforeEach(async () => {
    // unsubscribes has no FK to organizations any more (that is the point of it),
    // so it has to be truncated explicitly rather than by cascade.
    await pool().query('TRUNCATE organizations, unsubscribes CASCADE');
  });

  // ── Retention: 24 months, exactly ────────────────────────────────────────

  describe('survey response retention', () => {
    it('keeps responses inside 24 months and deletes those outside it', async () => {
      const org = await seedOrg('acme');
      await seedResponse(org, 'sub_23mo', '23 months');
      await seedResponse(org, 'sub_24mo_minus_a_day', '24 months - 1 day');
      await seedResponse(org, 'sub_24mo_plus_a_day', '24 months + 1 day');
      await seedResponse(org, 'sub_25mo', '25 months');

      const result = await runPurge();

      expect(await surviving('survey_responses')).toEqual([
        'sub_23mo@example.com',
        'sub_24mo_minus_a_day@example.com',
      ]);
      expect(result.responses).toBe(2);
    });

    it('is measured from created_at, not surveyed_at', async () => {
      // A response collected 25 months ago but only answered last week is still
      // 25 months of retained personal data — the promise is about when it was
      // collected.
      const org = await seedOrg('acme');
      await seedResponse(org, 'sub_old', '25 months');
      await pool().query(
        `UPDATE survey_responses SET surveyed_at = now() - interval '7 days'`,
      );

      await runPurge();

      expect(await surviving('survey_responses')).toEqual([]);
    });

    it('deletes themes by week_of against the same window', async () => {
      const org = await seedOrg('acme');
      await seedTheme(org, 'inside-window', '23 months');
      await seedTheme(org, 'outside-window', '25 months');

      const result = await runPurge();

      expect(await surviving('themes')).toEqual(['inside-window']);
      expect(result.themes).toBe(1);
    });
  });

  // ── Login tokens ─────────────────────────────────────────────────────────

  describe('expired login tokens', () => {
    it('deletes tokens over a day past expiry and keeps fresher ones', async () => {
      const org = await seedOrg('acme');
      await seedLoginToken(org, 'live', { expiresIn: '10 minutes' });
      await seedLoginToken(org, 'expired-recently', { expiredFor: '2 hours' });
      await seedLoginToken(org, 'expired-long-ago', { expiredFor: '2 days' });

      const result = await runPurge();

      const { rows } = await pool().query('SELECT token_hash FROM login_tokens ORDER BY 1');
      expect(rows.map((r) => r.token_hash)).toEqual(['expired-recently', 'live']);
      expect(result.tokens).toBe(1);
    });
  });

  // ── Erasure: the 30-day grace period ─────────────────────────────────────

  describe('hard-deleting orgs whose deletion grace period elapsed', () => {
    it('keeps an org that asked 29 days ago and deletes one that asked 31 days ago', async () => {
      await seedOrg('asked-29-days-ago', { deletionRequestedAt: '29 days' });
      await seedOrg('asked-31-days-ago', { deletionRequestedAt: '31 days' });
      await seedOrg('never-asked', { createdAt: '400 days' , stripeApiKeyEnc: 'enc' });

      const result = await runPurge();

      expect(await surviving('organizations')).toEqual(['asked-29-days-ago', 'never-asked']);
      expect(result.orgsDeleted).toBe(1);
    });

    it('cascades the org’s own data away with it', async () => {
      const doomed = await seedOrg('doomed', { deletionRequestedAt: '31 days' });
      await seedResponse(doomed, 'sub_recent', '1 day');
      await seedTheme(doomed, 'recent-theme', '7 days');
      await seedLoginToken(doomed, 'live-token', { expiresIn: '10 minutes' });

      await runPurge();

      expect(await surviving('survey_responses')).toEqual([]);
      expect(await surviving('themes')).toEqual([]);
      const { rows } = await pool().query('SELECT count(*)::int AS n FROM login_tokens');
      expect(rows[0].n).toBe(0);
    });

    it('keeps the opt-out suppression list, which must outlive the org', async () => {
      // Privacy policy s8 / DPA s9: an unsubscribe survives account deletion so
      // the address can never be re-surveyed. This is why the migration drops
      // unsubscribes' FK — with it, this DELETE would cascade the promise away.
      const doomed = await seedOrg('doomed', { deletionRequestedAt: '31 days' });
      await pool().query(
        `INSERT INTO unsubscribes (org_id, customer_email) VALUES ($1, 'optout@example.com')`,
        [doomed],
      );

      await runPurge();

      expect(await surviving('organizations')).toEqual([]);
      expect(await surviving('unsubscribes')).toEqual(['optout@example.com']);
    });
  });

  // ── Abandoned signups ────────────────────────────────────────────────────

  describe('abandoned signups', () => {
    it('deletes a 31-day-old stub that never connected anything and never signed in', async () => {
      await seedOrg('abandoned', { createdAt: '31 days' });

      const result = await runPurge();

      expect(await surviving('organizations')).toEqual([]);
      expect(result.abandonedDeleted).toBe(1);
    });

    it('keeps a stub that is only 29 days old', async () => {
      await seedOrg('too-young', { createdAt: '29 days' });

      const result = await runPurge();

      expect(await surviving('organizations')).toEqual(['too-young']);
      expect(result.abandonedDeleted).toBe(0);
    });

    it('never deletes an org with a Stripe key', async () => {
      await seedOrg('has-stripe', { createdAt: '400 days', stripeApiKeyEnc: 'enc-key' });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['has-stripe']);
    });

    it('never deletes an org with a Polar subscription', async () => {
      await seedOrg('has-polar', { createdAt: '400 days', polarSubscriptionId: 'sub_polar' });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['has-polar']);
    });

    it('never deletes an org with a used login token', async () => {
      const org = await seedOrg('signed-in', { createdAt: '400 days' });
      // Still inside the login_tokens cleanup's grace, so it survives step (b)
      // and is there to protect the org in step (d).
      await seedLoginToken(org, 'used-recent', { expiredFor: '2 hours', used: true });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['signed-in']);
    });

    it('deletes an org whose only token was requested and never clicked', async () => {
      const org = await seedOrg('never-clicked', { createdAt: '400 days' });
      await seedLoginToken(org, 'unused', { expiredFor: '2 hours', used: false });

      await runPurge();

      expect(await surviving('organizations')).toEqual([]);
    });

    it("is not fooled by another org's used token", async () => {
      // Guards the NOT EXISTS correlation (lt.org_id = o.id): drop it and one
      // signed-in org anywhere protects every abandoned stub in the table.
      const signedIn = await seedOrg('signed-in', { createdAt: '400 days' });
      await seedLoginToken(signedIn, 'used-recent', { expiredFor: '2 hours', used: true });
      await seedOrg('abandoned', { createdAt: '400 days' });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['signed-in']);
    });

    it.fails(
      'KNOWN BUG: hard-deletes a live free-plan org because its used login token already expired',
      async () => {
        // Login tokens live 15 minutes (auth/request/route.ts TOKEN_TTL_MS) and
        // step (b) of this same run deletes every token whose expires_at is over
        // a day old. So `NOT EXISTS (used token)` does not mean "never signed
        // in" — it means "has not signed in within roughly the last day", which
        // every normal user satisfies.
        //
        // The org below is a real, active, free-plan account: a founder who
        // signed in a week ago, has survey data, and simply has not connected
        // Stripe (or disconnected it from Settings, which NULLs the key). It is
        // silently hard-deleted with all of its data, with no deletion request
        // and no grace period.
        //
        // Marked it.fails so the suite stays green while the bug stands and
        // fails loudly the moment it is fixed. Delete the wrapper then.
        const org = await seedOrg('live-free-plan-org', { createdAt: '90 days' });
        await pool().query(
          `INSERT INTO users (org_id, email) VALUES ($1, 'founder@example.com')`,
          [org],
        );
        await seedResponse(org, 'sub_recent', '3 days');
        await seedLoginToken(org, 'used-a-week-ago', { expiredFor: '7 days', used: true });

        await runPurge();

        expect(await surviving('organizations')).toEqual(['live-free-plan-org']);
      },
    );
  });
});
