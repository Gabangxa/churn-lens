import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { assertThrowawayDatabase } from '../../../../../e2e/helpers/throwaway-db';

/**
 * POST /api/auth/request against a real PostgreSQL: what an address has to
 * look like before the route lets it anywhere near the database.
 *
 * request.test.ts stubs the database, so it can only say which SQL the route
 * emits. The failure this suite exists for is the database's own answer to
 * input the route should never have sent it: a NUL byte in a text parameter
 * is Postgres error 22021, which the route's catch-all reports — so any
 * unauthenticated caller could page the operator at will, once per request.
 * Only a real engine raises that, so only a real engine can show it is gone.
 *
 * Real rate limiter (each request gets its own client IP, so the per-IP
 * bucket never fills), real session/CSRF check, real error reporting.
 * Resend is a capture: no inbox is ever involved.
 *
 * Same contract as the other *.db.test.ts suites: skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database. It TRUNCATEs
 * organizations (cascading to users and login_tokens) between tests.
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
  // The signup path's org + owner insert, in a real transaction on the test pool.
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

interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
}
const sentEmails = vi.hoisted(() => [] as CapturedEmail[]);
vi.mock('@/lib/resend', () => ({
  FROM_EMAIL: 'login@churnlens.test',
  getResend: () => ({
    emails: {
      send: async (message: CapturedEmail) => {
        sentEmails.push(message);
        return { data: { id: `email_${sentEmails.length}` }, error: null };
      },
    },
  }),
}));

import { POST } from '../request/route';
// Real: "no alert" is asserted on what reportError recorded. ALERT_EMAIL is
// pinned empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const APP_URL = 'https://app.churnlens.test';

let clientIpCounter = 0;

/** What the login form sends: a same-origin JSON POST, from its own client IP. */
function requestLink(email: unknown) {
  clientIpCounter += 1;
  return POST(
    new NextRequest('http://localhost/api/auth/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        // clientIp() reads the LAST hop; a fresh one per request keeps the
        // per-IP bucket (5 per 10 minutes) out of every test's way.
        'x-forwarded-for': `10.77.${Math.floor(clientIpCounter / 250)}.${(clientIpCounter % 250) + 1}`,
      },
      body: JSON.stringify({ email }),
    }),
  );
}

async function rowCounts(): Promise<{ organizations: number; users: number; loginTokens: number }> {
  const { rows } = await pool().query<{ organizations: string; users: string; login_tokens: string }>(
    `SELECT (SELECT count(*) FROM organizations) AS organizations,
            (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM login_tokens) AS login_tokens`,
  );
  return {
    organizations: Number(rows[0].organizations),
    users: Number(rows[0].users),
    loginTokens: Number(rows[0].login_tokens),
  };
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/auth/request against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'login_tokens' AND column_name = 'redirect_to'`,
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
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('ENCRYPTION_KEY', 'e'.repeat(64));
    resetErrorReports();
    sentEmails.length = 0;
    await pool().query('TRUNCATE organizations CASCADE');
  });

  it('creates the account and emails a link for an ordinary address', async () => {
    const res = await requestLink('founder@example.com');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const { rows } = await pool().query<{ email: string }>('SELECT email FROM users');
    expect(rows).toEqual([{ email: 'founder@example.com' }]);
    expect(await rowCounts()).toEqual({ organizations: 1, users: 1, loginTokens: 1 });
    expect(sentEmails.map((m) => m.to)).toEqual(['founder@example.com']);
    expect(sentEmails[0].text).toContain(`${APP_URL}/api/auth/verify?token=`);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('still trims and lowercases what the form sends before checking it', async () => {
    const res = await requestLink('  Founder@Example.COM \n');

    expect(res.status).toBe(200);
    const { rows } = await pool().query<{ email: string }>('SELECT email FROM users');
    expect(rows).toEqual([{ email: 'founder@example.com' }]);
  });

  // A NUL inside a text parameter is Postgres 22021 — before this check, an
  // alert any anonymous caller could trigger. The other C0 controls and DEL
  // would not error, but they would be stored as part of an account's
  // address and handed to Resend; no address a person can type contains one.
  it.each([
    ['a NUL byte in the local part', 'found\u0000er@example.com'],
    ['a trailing NUL byte (trim does not remove it)', 'founder@example.com\u0000'],
    ['a NUL byte in the domain', 'founder@exam\u0000ple.com'],
    ['a SOH control character', 'founder\u0001@example.com'],
    ['a unit separator', 'founder@example.com\u001f.evil'],
    ['DEL', 'founder\u007f@example.com'],
    ['a line break inside the address', 'founder\n@example.com'],
    ['a tab inside the address', 'founder\t@example.com'],
  ])('refuses an address containing %s: 400, no account, no email, no alert', async (_label, email) => {
    const res = await requestLink(email);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A valid email address is required.' });
    expect(await rowCounts()).toEqual({ organizations: 0, users: 0, loginTokens: 0 });
    expect(sentEmails).toEqual([]);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  // The shape the login form's <input type="email"> already enforces in the
  // browser (the WHATWG "valid email address"), so only a hand-made request
  // can be turned away by it — never a founder typing into the form.
  it.each([
    ['no local part', '@example.com'],
    ['no domain', 'founder@'],
    ['two @ signs', 'founder@evil.example@example.com'],
    ['a space inside', 'found er@example.com'],
    ['a display name', 'Founder <founder@example.com>'],
    ['a list of addresses', 'founder@example.com,victim@example.com'],
    ['a domain label that starts with a hyphen', 'founder@-example.com'],
    ['an empty domain label', 'founder@example..com'],
    ['non-ASCII characters', 'fóunder@example.com'],
    // Every label within the 63-character limit, so only the overall cap refuses it.
    ['more than 254 characters', `${'a'.repeat(64)}@${['b', 'c', 'd', 'e'].map((c) => c.repeat(60)).join('.')}.com`],
  ])('refuses an address with %s', async (_label, email) => {
    const res = await requestLink(email);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A valid email address is required.' });
    expect(await rowCounts()).toEqual({ organizations: 0, users: 0, loginTokens: 0 });
    expect(sentEmails).toEqual([]);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it.each([
    ['plus addressing', 'founder+churnlens@example.com'],
    ['a subdomain', 'founder@mail.example.co.za'],
    ['RFC 5322 punctuation in the local part', "o'brien.j_x-y=z!#$%&*/?^`{|}~@example.com"],
    ['a single-label domain', 'founder@localhost'],
  ])('accepts an address with %s', async (_label, email) => {
    const res = await requestLink(email);

    expect(res.status).toBe(200);
    expect(await rowCounts()).toEqual({ organizations: 1, users: 1, loginTokens: 1 });
  });
});
