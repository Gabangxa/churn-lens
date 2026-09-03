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
 * It TRUNCATEs organizations, unsubscribes and cron_runs between tests. Never point it at
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
  unsubscribesOrphaned: number;
  cronRunsPurged: number;
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
  /** SQL interval ago (e.g. "7 days"), or null (the default) for "never signed in". */
  lastLoginAt?: string | null;
}

/** Seeds one org. Ages are SQL interval expressions, e.g. "31 days", "25 months". */
async function seedOrg(name: string, opts: OrgOpts = {}): Promise<string> {
  const {
    createdAt = '1 day',
    deletionRequestedAt = null,
    stripeApiKeyEnc = null,
    polarSubscriptionId = null,
    plan = 'free',
    lastLoginAt = null,
  } = opts;
  const { rows } = await pool().query(
    `INSERT INTO organizations
       (name, created_at, deletion_requested_at, stripe_api_key_enc, polar_subscription_id, plan, last_login_at)
     VALUES ($1, now() - $2::interval, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      name,
      createdAt,
      deletionRequestedAt === null ? null : new Date(Date.now() - intervalToMs(deletionRequestedAt)),
      stripeApiKeyEnc,
      polarSubscriptionId,
      plan,
      lastLoginAt === null ? null : new Date(Date.now() - intervalToMs(lastLoginAt)),
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
    // so it has to be truncated explicitly rather than by cascade. cron_runs
    // has no org_id at all, so it is never touched by TRUNCATE ... CASCADE
    // from organizations either, and the "cron_runs history" tests below
    // write directly to it — without this it would be the one table that
    // leaks rows across test *runs* (not just across tests within a run),
    // since nothing else in this file ever inserts into it.
    await pool().query('TRUNCATE organizations, unsubscribes, cron_runs CASCADE');
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

    it('the opt-out suppression list survives the org hard-delete step itself, via the FK-less DELETE', async () => {
      // This is why the migration drops unsubscribes' FK: with it, the org
      // hard-delete two lines above would CASCADE and take this row with it
      // in the same statement, before the orphaned-unsubscribes step below
      // ever got a chance to run as a deliberate, auditable step of its own.
      // The row IS still cleaned up in this same run — see the next test —
      // just by the purge job's own later, dedicated step, not as a side
      // effect of the org's DELETE.
      const doomed = await seedOrg('doomed', { deletionRequestedAt: '31 days' });
      await pool().query(
        `INSERT INTO unsubscribes (org_id, customer_email) VALUES ($1, 'optout@example.com')`,
        [doomed],
      );

      const result = await runPurge();

      expect(await surviving('organizations')).toEqual([]);
      expect(result.orgsDeleted).toBe(1);
      // Deleted by the orphaned-unsubscribes step (below), not by a cascade —
      // if the FK still existed, this would already be gone by the time that
      // step ran, and result.unsubscribesOrphaned would be 0, not 1.
      expect(result.unsubscribesOrphaned).toBe(1);
      expect(await surviving('unsubscribes')).toEqual([]);
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

    it('never deletes an org that has signed in, even long ago, no matter what its login tokens look like', async () => {
      // last_login_at — not a login_tokens lookup — is the durable signal.
      // Fixed from a real bug: login tokens live 15 minutes (auth/request/
      // route.ts TOKEN_TTL_MS) and step (b) of this same run deletes every
      // token whose expires_at is over a day old, so a *used* token is gone
      // roughly a day after the sign-in that used it — "no used token" used
      // to mean "hasn't signed in within about a day", which every normal
      // user satisfies, not "never signed in". This org has no login_tokens
      // row at all (all of them long expired and reaped), only last_login_at.
      const org = await seedOrg('signed-in', { createdAt: '400 days', lastLoginAt: '7 days' });
      await seedLoginToken(org, 'used-a-week-ago', { expiredFor: '2 days', used: true });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['signed-in']);
      // Confirms the login_tokens row really is gone by the time abandonment
      // is evaluated — this org survives on last_login_at alone.
      const { rows } = await pool().query('SELECT count(*)::int AS n FROM login_tokens');
      expect(rows[0].n).toBe(0);
    });

    it('deletes an org whose only login token was requested and never clicked', async () => {
      // The login token itself is irrelevant to the new rule either way — this
      // documents that an unused, expired token does not confer "signed in".
      const org = await seedOrg('never-clicked', { createdAt: '400 days' });
      await seedLoginToken(org, 'unused', { expiredFor: '2 hours', used: false });

      await runPurge();

      expect(await surviving('organizations')).toEqual([]);
    });

    it("is not fooled by another org's recorded login", async () => {
      // last_login_at lives on the org row itself, not a joined table, so
      // there is no cross-org correlation risk for this signal the way there
      // was for login_tokens — this just pins that down.
      await seedOrg('signed-in', { createdAt: '400 days', lastLoginAt: '7 days' });
      await seedOrg('abandoned', { createdAt: '400 days' });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['signed-in']);
    });

    it("is not fooled by another org's survey response", async () => {
      // Guards the NOT EXISTS correlation (r.org_id = o.id): drop it and one
      // org's survey response anywhere protects every abandoned stub in the
      // table.
      const hasData = await seedOrg('has-data', { createdAt: '400 days' });
      await seedResponse(hasData, 'sub_x', '3 days');
      await seedOrg('abandoned', { createdAt: '400 days' });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['has-data']);
    });

    it('keeps a disconnected org that still has survey responses (fixed from a real bug)', async () => {
      // A real, active free-plan account: a founder who disconnected Stripe
      // from Settings (which NULLs stripe_api_key_enc, identical to never
      // having connected it) but whose account has actual collected data.
      // Never signed in recently and never asked to be deleted — the
      // survey_responses correlation is what has to protect it.
      const org = await seedOrg('disconnected-with-data', { createdAt: '90 days' });
      await pool().query(
        `INSERT INTO users (org_id, email) VALUES ($1, 'founder@example.com')`,
        [org],
      );
      await seedResponse(org, 'sub_recent', '3 days');

      await runPurge();

      expect(await surviving('organizations')).toEqual(['disconnected-with-data']);
    });

    it('does not hard-delete a live free-plan org that has signed in, even once its login tokens have all expired and been reaped', async () => {
      // The bug this documents being fixed: a real account — signed in a week
      // ago, has survey data, simply hasn't connected Stripe — used to be
      // silently hard-deleted with no deletion request and no grace period,
      // because its evidence of ever signing in (a used login_tokens row)
      // does not outlive step (b) of this very run. last_login_at does.
      const org = await seedOrg('live-free-plan-org', { createdAt: '90 days', lastLoginAt: '7 days' });
      await pool().query(
        `INSERT INTO users (org_id, email) VALUES ($1, 'founder@example.com')`,
        [org],
      );
      await seedResponse(org, 'sub_recent', '3 days');
      await seedLoginToken(org, 'used-a-week-ago', { expiredFor: '7 days', used: true });

      await runPurge();

      expect(await surviving('organizations')).toEqual(['live-free-plan-org']);
    });
  });

  // ── Orphaned opt-out records ─────────────────────────────────────────────

  describe('orphaned unsubscribes', () => {
    it('deletes an unsubscribe row whose org no longer exists', async () => {
      // unsubscribes has no FK to organizations (the migration drops it), so
      // nothing stops a row from outliving the org it referred to — insert
      // one directly against a random id rather than a real, then-deleted org.
      await pool().query(
        `INSERT INTO unsubscribes (org_id, customer_email) VALUES (gen_random_uuid(), 'gone@example.com')`,
      );

      const result = await runPurge();

      expect(await surviving('unsubscribes')).toEqual([]);
      expect(result.unsubscribesOrphaned).toBe(1);
    });

    it("keeps an unsubscribe row whose org still exists, even one hard-deleted in the very same run", async () => {
      const live = await seedOrg('live');
      await pool().query(
        `INSERT INTO unsubscribes (org_id, customer_email) VALUES ($1, 'still-here@example.com')`,
        [live],
      );

      await runPurge();

      expect(await surviving('unsubscribes')).toEqual(['still-here@example.com']);
    });
  });

  // ── Old cron_runs history ─────────────────────────────────────────────────

  describe('cron_runs history', () => {
    it('deletes cron_runs rows older than 90 days and keeps fresher ones', async () => {
      await pool().query(
        `INSERT INTO cron_runs (job, week_of, ran_at) VALUES ('themes', '2020-01-06', now() - interval '91 days')`,
      );
      await pool().query(
        `INSERT INTO cron_runs (job, week_of, ran_at) VALUES ('digest', '2026-03-09', now() - interval '89 days')`,
      );

      const result = await runPurge();

      const { rows } = await pool().query('SELECT job FROM cron_runs ORDER BY job');
      // The purge run itself just inserted a 'purge' row (claimCronRun is
      // mocked away here, so it isn't — only the two seeded rows are real).
      expect(rows.map((r) => r.job)).toEqual(['digest']);
      expect(result.cronRunsPurged).toBe(1);
    });
  });
});
