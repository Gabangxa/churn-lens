import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { assertThrowawayDatabase } from '../../../../../../e2e/helpers/throwaway-db';

/**
 * POST /api/legal/accept — the dashboard banner's "I agree" — against a real
 * PostgreSQL.
 *
 * This is how the orgs that connected before acceptance existed (and every org
 * after a LEGAL_DOCS_VERSION bump) get an acceptance on record, so what matters
 * is what lands in the row: written only for the session's own org, only from
 * our own origin, on the database clock, and never moved by a repeat click.
 * Auth is the real module with a genuinely signed cookie, so these also prove
 * the route is wired to the real session and same-origin checks. Skipped
 * unless TEST_DATABASE_URL points at a migrated throwaway database.
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
import { setOrgCookie } from '@/lib/auth';
import { LEGAL_DOCS_VERSION } from '@/lib/legal-version';

const COOKIE_NAME = 'churnlens_org_id';
const OLD_VERSION = '2000-01-01';

function signedCookieFor(orgId: string): string {
  const carrier = NextResponse.next();
  setOrgCookie(carrier, orgId);
  return carrier.cookies.get(COOKIE_NAME)!.value;
}

function acceptRequest(opts: {
  orgId?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}) {
  return new NextRequest('http://localhost/api/legal/accept', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.orgId ? { cookie: `${COOKIE_NAME}=${signedCookieFor(opts.orgId)}` } : {}),
      ...opts.headers,
    },
    body: opts.rawBody ?? JSON.stringify(opts.body ?? { acceptedLegalVersion: LEGAL_DOCS_VERSION }),
  });
}

interface Acceptance {
  legal_accepted_at: Date | null;
  legal_accepted_version: string | null;
}

async function seedOrg(acceptance?: { version: string; acceptedAt: Date }): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations (name, legal_accepted_version, legal_accepted_at)
     VALUES ('db-suite org', $1, $2)
     RETURNING id`,
    [acceptance?.version ?? null, acceptance?.acceptedAt ?? null],
  );
  return rows[0].id;
}

async function readAcceptance(orgId: string): Promise<Acceptance> {
  const { rows } = await pool().query<Acceptance>(
    'SELECT legal_accepted_at, legal_accepted_version FROM organizations WHERE id = $1',
    [orgId],
  );
  return rows[0];
}

/** The database's own clock, read outside any statement under test. */
async function dbClock(): Promise<Date> {
  const { rows } = await pool().query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return rows[0].now;
}

const NOTHING_RECORDED: Acceptance = { legal_accepted_at: null, legal_accepted_version: null };

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/legal/accept against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'legal_accepted_version'`,
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
    vi.stubEnv('ENCRYPTION_KEY', 'd'.repeat(64));
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.churnlens.test');
    await pool().query('TRUNCATE organizations CASCADE');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('guards', () => {
    it('requires a session: no cookie is a 401 and nothing is written', async () => {
      const orgId = await seedOrg();

      const res = await POST(acceptRequest({}));

      expect(res.status).toBe(401);
      expect(await readAcceptance(orgId)).toEqual(NOTHING_RECORDED);
    });

    it('a forged session cookie is a 401 and nothing is written', async () => {
      const orgId = await seedOrg();

      const res = await POST(
        acceptRequest({ headers: { cookie: `${COOKIE_NAME}=${orgId}.deadbeef` } }),
      );

      expect(res.status).toBe(401);
      expect(await readAcceptance(orgId)).toEqual(NOTHING_RECORDED);
    });

    it('rejects a foreign Origin even with a valid session, before writing anything', async () => {
      // A third-party page must not be able to click "I agree" on a signed-in
      // founder's behalf.
      const orgId = await seedOrg();

      const res = await POST(acceptRequest({ orgId, headers: { origin: 'https://evil.example' } }));

      expect(res.status).toBe(403);
      expect(await readAcceptance(orgId)).toEqual(NOTHING_RECORDED);
    });

    it('rejects Sec-Fetch-Site: cross-site when no Origin is sent', async () => {
      const orgId = await seedOrg();

      const res = await POST(acceptRequest({ orgId, headers: { 'sec-fetch-site': 'cross-site' } }));

      expect(res.status).toBe(403);
      expect(await readAcceptance(orgId)).toEqual(NOTHING_RECORDED);
    });

    it('accepts a same-origin request', async () => {
      const orgId = await seedOrg();

      const res = await POST(
        acceptRequest({ orgId, headers: { origin: 'https://app.churnlens.test' } }),
      );

      expect(res.status).toBe(200);
      expect((await readAcceptance(orgId)).legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
    });

    it('a session the org has since signed out everywhere is a 401 and nothing is written', async () => {
      // The session gate is a database check (src/lib/auth.ts). A cookie that
      // still verifies but predates a logout-everywhere must not be able to
      // agree to anything on the founder's behalf.
      const orgId = await seedOrg();
      const cookieRequest = acceptRequest({ orgId });
      await pool().query('UPDATE organizations SET sessions_valid_after = $2 WHERE id = $1', [
        orgId,
        new Date(Date.now() + 60_000),
      ]);

      const res = await POST(cookieRequest);

      expect(res.status).toBe(401);
      expect(await readAcceptance(orgId)).toEqual(NOTHING_RECORDED);
    });

    it('a valid session for an org that no longer exists is a 401 that clears the cookie', async () => {
      const res = await POST(acceptRequest({ orgId: '00000000-0000-4000-8000-000000000000' }));

      expect(res.status).toBe(401);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(`${COOKIE_NAME}=`);
      expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    });
  });

  describe('which version is accepted', () => {
    it.each([
      ['no version at all', {}],
      ['a bare boolean', { acceptedLegalVersion: true }],
      ['an empty string', { acceptedLegalVersion: '' }],
    ])('refuses %s with a 400 and writes nothing', async (_label, body) => {
      const orgId = await seedOrg();

      const res = await POST(acceptRequest({ orgId, body }));

      expect(res.status).toBe(400);
      expect(await readAcceptance(orgId)).toEqual(NOTHING_RECORDED);
    });

    it('refuses a version that is no longer current and leaves the old record alone', async () => {
      // A banner rendered before a version bump still carries the old string;
      // the founder must reload and see the current documents first.
      const prior = { version: OLD_VERSION, acceptedAt: new Date('2025-01-01T00:00:00Z') };
      const orgId = await seedOrg(prior);

      const res = await POST(acceptRequest({ orgId, body: { acceptedLegalVersion: OLD_VERSION } }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/changed .*Reload the page/);
      expect(await readAcceptance(orgId)).toEqual({
        legal_accepted_at: prior.acceptedAt,
        legal_accepted_version: prior.version,
      });
    });

    it('answers 400 for a body that is not JSON', async () => {
      const orgId = await seedOrg();

      const res = await POST(acceptRequest({ orgId, rawBody: 'not json' }));

      expect(res.status).toBe(400);
      expect(await readAcceptance(orgId)).toEqual(NOTHING_RECORDED);
    });
  });

  describe('what is recorded', () => {
    it('records the current version on the database clock, ignoring any client-sent time', async () => {
      const orgId = await seedOrg();
      const before = await dbClock();

      const res = await POST(
        acceptRequest({
          orgId,
          body: {
            acceptedLegalVersion: LEGAL_DOCS_VERSION,
            acceptedAt: '1999-01-01T00:00:00.000Z',
            legalAcceptedAt: '1999-01-01T00:00:00.000Z',
          },
        }),
      );
      const after = await dbClock();

      expect(res.status).toBe(200);
      const recorded = await readAcceptance(orgId);
      expect(recorded.legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
      expect(recorded.legal_accepted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(recorded.legal_accepted_at!.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(await res.json()).toEqual({
        ok: true,
        version: LEGAL_DOCS_VERSION,
        acceptedAt: recorded.legal_accepted_at!.toISOString(),
      });
    });

    it('is idempotent: accepting again keeps the original time', async () => {
      // A double click, a retry, or a second tab must not move the record of
      // when the founder agreed to this wording.
      const orgId = await seedOrg();

      const first = await (await POST(acceptRequest({ orgId }))).json();
      const afterFirst = await readAcceptance(orgId);
      const second = await POST(acceptRequest({ orgId }));

      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(first);
      expect(await readAcceptance(orgId)).toEqual(afterFirst);
    });

    it('keeps an earlier acceptance of the current version untouched', async () => {
      const firstAcceptedAt = new Date('2026-01-15T09:30:00Z');
      const orgId = await seedOrg({ version: LEGAL_DOCS_VERSION, acceptedAt: firstAcceptedAt });

      const res = await POST(acceptRequest({ orgId }));

      expect(res.status).toBe(200);
      expect(await readAcceptance(orgId)).toEqual({
        legal_accepted_at: firstAcceptedAt,
        legal_accepted_version: LEGAL_DOCS_VERSION,
      });
    });

    it('moves an org that accepted an older version onto the current one, with a fresh time', async () => {
      const orgId = await seedOrg({ version: OLD_VERSION, acceptedAt: new Date('2025-01-01T00:00:00Z') });
      const before = await dbClock();

      const res = await POST(acceptRequest({ orgId }));

      expect(res.status).toBe(200);
      const recorded = await readAcceptance(orgId);
      expect(recorded.legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
      expect(recorded.legal_accepted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("only ever touches the session's own org", async () => {
      const mine = await seedOrg();
      const someoneElse = await seedOrg();

      await POST(acceptRequest({ orgId: mine }));

      expect((await readAcceptance(mine)).legal_accepted_version).toBe(LEGAL_DOCS_VERSION);
      expect(await readAcceptance(someoneElse)).toEqual(NOTHING_RECORDED);
    });

    it('the database itself refuses half an acceptance record', async () => {
      // organizations_legal_acceptance_pair_check (scripts/migrate.js). The
      // keep-the-original-time rule both write paths use relies on a matching
      // version always having a time beside it.
      await expect(
        pool().query(
          `INSERT INTO organizations (name, legal_accepted_version) VALUES ('half', $1)`,
          [LEGAL_DOCS_VERSION],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool().query(`INSERT INTO organizations (name, legal_accepted_at) VALUES ('half', now())`),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
