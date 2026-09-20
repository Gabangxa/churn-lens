import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { assertThrowawayDatabase } from '../../../../../../e2e/helpers/throwaway-db';

/**
 * The status route against a real PostgreSQL.
 *
 * route.test.ts pins the SQL text and the mapping; only a real engine can prove
 * the column names exist and the FILTER/cast syntax parses. Same contract as
 * src/app/api/purge/__tests__/route.db.test.ts: skipped unless TEST_DATABASE_URL
 * points at a migrated throwaway database, which CI provisions.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const dbState = vi.hoisted(() => ({ pool: null as Pool | null }));
function pool(): Pool {
  if (!dbState.pool) throw new Error('test pool not initialised');
  return dbState.pool;
}

vi.mock('@/lib/db', () => ({
  query: async (text: string, params?: unknown[]) => (await pool().query(text, params)).rows,
  queryOne: async (text: string, params?: unknown[]) =>
    (await pool().query(text, params)).rows[0] ?? null,
}));

// Auth is deliberately NOT mocked here: the unit suite stubs it, so this is
// the one place that proves the route is actually wired to CRON_SECRET.
import { GET } from '../route';
import { reportingWeek } from '@/lib/week';
import { todayDateStr } from '@/lib/cron';

const SECRET = 'db-suite-cron-secret';

function authed() {
  return new Request('http://localhost/api/admin/status', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('GET /api/admin/status against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'last_login_at'`,
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
    vi.stubEnv('CRON_SECRET', SECRET);
    // organizations cascades to users, login_tokens, survey_responses,
    // digest_sends and unsubscribes; cron_runs has no FK.
    await pool().query('TRUNCATE organizations, cron_runs CASCADE');
  });

  it('rejects a wrong bearer token with the real verifyCronSecret', async () => {
    const res = await GET(
      new Request('http://localhost/api/admin/status', { headers: { authorization: 'Bearer wrong' } }),
    );

    expect(res.status).toBe(401);
  });

  it('runs every statement cleanly on an empty schema', async () => {
    const res = await GET(authed());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.errors).toEqual([]);
    expect(json.db.ok).toBe(true);
    expect(json.activity.orgs.total).toBe(0);
    expect(json.pipeline.jobs.map((j: { status: string | null }) => j.status)).toEqual([null, null, null]);
  });

  it('counts real rows with the intended windows', async () => {
    const { weekOfStr } = reportingWeek(new Date());
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO organizations (name, stripe_api_key_enc, plan, last_login_at)
       VALUES ('recent', 'enc', 'starter', now() - interval '1 hour'),
              ('stale',  NULL,  'free',    now() - interval '10 days')
       RETURNING id`,
    );
    const [recent] = rows;
    await pool().query(
      `INSERT INTO survey_responses (org_id, customer_email, stripe_subscription_id, token, surveyed_at)
       VALUES ($1, 'answered@example.com', 'sub_1', 'tok_1', now()),
              ($1, 'pending@example.com',  'sub_2', 'tok_2', NULL)`,
      [recent.id],
    );
    await pool().query(
      `INSERT INTO cron_runs (job, week_of, status, attempts, processed)
       VALUES ('themes', $1::date, 'succeeded', 1, 2)`,
      [weekOfStr],
    );
    await pool().query(
      `INSERT INTO digest_sends (org_id, week_of) VALUES ($1, $2::date)`,
      [recent.id, weekOfStr],
    );

    // A digest for the previous week must not count as "this week".
    await pool().query(
      `INSERT INTO digest_sends (org_id, week_of) VALUES ($1, $2::date - interval '7 days')`,
      [rows[1].id, weekOfStr],
    );

    const json = await (await GET(authed())).json();

    expect(json.errors).toEqual([]);
    expect(json.activity.orgs).toEqual({ total: 2, connected: 1, paid: 1, pendingDeletion: 0 });
    expect(json.activity.logins).toEqual({ last24h: 1, last7d: 1 });
    expect(json.activity.surveys).toMatchObject({ respondedToday: 1, awaitingEmail: 1 });
    expect(json.activity.digestSendsThisWeek).toBe(1);
    expect(json.pipeline.jobs[0]).toMatchObject({ job: 'themes', status: 'succeeded', action: 'skip', processed: 2 });
  });

  it('counts only unanswered, unsent, real surveys as awaiting email', async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('o') RETURNING id`,
    );
    const orgId = rows[0].id;
    await pool().query(
      `INSERT INTO survey_responses
         (org_id, customer_email, stripe_subscription_id, token, surveyed_at, is_test, survey_email_sent_at)
       VALUES ($1, 'waiting@example.com',  'sub_a', 'tok_a', NULL,  false, NULL),
              ($1, 'answered@example.com', 'sub_b', 'tok_b', now(), false, NULL),
              ($1, 'test@example.com',     'sub_c', 'tok_c', NULL,  true,  NULL),
              ($1, 'sent@example.com',     'sub_d', 'tok_d', NULL,  false, now())`,
      [orgId],
    );

    const json = await (await GET(authed())).json();

    expect(json.errors).toEqual([]);
    expect(json.activity.surveys.awaitingEmail).toBe(1);
  });

  it("maps a purge run keyed by today's UTC date even when the session timezone is not UTC", async () => {
    // Postgres would otherwise parse/compare `date` values in the session
    // zone; the route passes a UTC date string and casts, so a Los Angeles
    // session (up to 8h behind) must still find the row.
    await pool().query(`SET TIME ZONE 'America/Los_Angeles'`);
    try {
      const today = todayDateStr(new Date());
      await pool().query(
        `INSERT INTO cron_runs (job, week_of, status, attempts) VALUES ('purge', $1::date, 'succeeded', 1)`,
        [today],
      );

      const json = await (await GET(authed())).json();

      expect(json.errors).toEqual([]);
      expect(json.pipeline.jobs[2]).toMatchObject({ job: 'purge', keyedBy: today, status: 'succeeded' });
    } finally {
      await pool().query(`SET TIME ZONE 'UTC'`);
    }
  });
});
