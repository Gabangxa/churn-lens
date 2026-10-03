import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { assertThrowawayDatabase } from '../../../e2e/helpers/throwaway-db';
import { recordLegalAcceptance } from '../legal-acceptance';
import { currentLegalDocsVersion } from '../legal-version';

/**
 * recordLegalAcceptance against a real PostgreSQL.
 *
 * It is the only writer of an org's Terms/DPA acceptance, for both the
 * dashboard banner (POST /api/legal/accept, whose suite covers it through the
 * route) and the connect route, which calls it inside the same transaction as
 * storing a Stripe key. This suite pins what both rely on: one row per version
 * in legal_acceptances, never overwritten; the organizations columns kept as
 * the cache of the current acceptance, written in the same statement; and
 * nothing at all landing when the caller's transaction rolls back.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated throwaway database. It
 * TRUNCATEs organizations between tests.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CURRENT_VERSION = currentLegalDocsVersion();
const OLD_VERSION = '2000-01-01';

interface Recorded {
  cache: { legal_accepted_version: string | null; legal_accepted_at: Date | null };
  history: { version: string; accepted_at: Date; source: string }[];
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('recordLegalAcceptance against a real database', () => {
  let pool: Pool;

  async function seedOrg(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('db-suite org') RETURNING id`,
    );
    return rows[0].id;
  }

  async function readRecorded(orgId: string): Promise<Recorded> {
    const cache = await pool.query<Recorded['cache']>(
      'SELECT legal_accepted_version, legal_accepted_at FROM organizations WHERE id = $1',
      [orgId],
    );
    const history = await pool.query<Recorded['history'][number]>(
      `SELECT version, accepted_at, source FROM legal_acceptances
       WHERE org_id = $1 ORDER BY accepted_at, version`,
      [orgId],
    );
    return { cache: cache.rows[0], history: history.rows };
  }

  async function dbClock(): Promise<Date> {
    const { rows } = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    return rows[0].now;
  }

  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool.query(`SELECT to_regclass('legal_acceptances') AS history`);
    if (rows[0].history === null) {
      throw new Error(
        'TEST_DATABASE_URL is not migrated — run `node scripts/migrate.js` against it first.',
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE organizations CASCADE');
  });

  it('records the current version in the history and the cache, at one database time', async () => {
    const orgId = await seedOrg();
    const before = await dbClock();

    const result = await recordLegalAcceptance(pool, orgId, 'connect');
    const after = await dbClock();

    const recorded = await readRecorded(orgId);
    expect(recorded.cache.legal_accepted_version).toBe(CURRENT_VERSION);
    const acceptedAt = recorded.cache.legal_accepted_at!;
    expect(acceptedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(acceptedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(recorded.history).toEqual([
      { version: CURRENT_VERSION, accepted_at: acceptedAt, source: 'connect' },
    ]);
    expect(result).toEqual({ version: CURRENT_VERSION, acceptedAt });
  });

  it('keeps every version an org has accepted: a new one adds a row and leaves the old', async () => {
    const orgId = await seedOrg();
    const oldAcceptedAt = new Date('2025-01-01T00:00:00Z');
    await pool.query(
      `UPDATE organizations SET legal_accepted_version = $2, legal_accepted_at = $3 WHERE id = $1`,
      [orgId, OLD_VERSION, oldAcceptedAt],
    );
    await pool.query(
      `INSERT INTO legal_acceptances (org_id, version, accepted_at, source) VALUES ($1, $2, $3, 'connect')`,
      [orgId, OLD_VERSION, oldAcceptedAt],
    );

    await recordLegalAcceptance(pool, orgId, 'banner');

    const recorded = await readRecorded(orgId);
    expect(recorded.cache.legal_accepted_version).toBe(CURRENT_VERSION);
    expect(recorded.history).toEqual([
      { version: OLD_VERSION, accepted_at: oldAcceptedAt, source: 'connect' },
      { version: CURRENT_VERSION, accepted_at: recorded.cache.legal_accepted_at, source: 'banner' },
    ]);
  });

  it('is idempotent per version: accepting again adds no row and moves no time', async () => {
    // A reconnect with a new key, a second tab, a double click: none is a new
    // agreement to the same wording.
    const orgId = await seedOrg();
    const first = await recordLegalAcceptance(pool, orgId, 'connect');
    const afterFirst = await readRecorded(orgId);

    const second = await recordLegalAcceptance(pool, orgId, 'banner');

    expect(second).toEqual(first);
    expect(await readRecorded(orgId)).toEqual(afterFirst);
  });

  it("lands nothing when the caller's transaction rolls back", async () => {
    // The connect route records acceptance in the same transaction as the
    // Stripe key, so a key write that fails takes the acceptance with it.
    const orgId = await seedOrg();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordLegalAcceptance(client, orgId, 'connect');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await readRecorded(orgId)).toEqual({
      cache: { legal_accepted_version: null, legal_accepted_at: null },
      history: [],
    });
  });

  it('returns null and writes nothing for an org that does not exist', async () => {
    const result = await recordLegalAcceptance(pool, '00000000-0000-4000-8000-000000000000', 'banner');

    expect(result).toBeNull();
    const { rows } = await pool.query('SELECT 1 FROM legal_acceptances');
    expect(rows).toHaveLength(0);
  });

  it("erasing an org erases its acceptance history with it", async () => {
    // Account deletion hard-deletes the organizations row (the purge job).
    // Whether acceptance evidence should instead outlive erasure is a legal
    // question; until it is answered, erasure means erasure.
    const orgId = await seedOrg();
    await recordLegalAcceptance(pool, orgId, 'connect');

    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);

    const { rows } = await pool.query('SELECT 1 FROM legal_acceptances WHERE org_id = $1', [orgId]);
    expect(rows).toHaveLength(0);
  });

  it('the database refuses an acceptance from anywhere but connect or the banner', async () => {
    const orgId = await seedOrg();

    await expect(
      pool.query(
        `INSERT INTO legal_acceptances (org_id, version, source) VALUES ($1, $2, 'api')`,
        [orgId, CURRENT_VERSION],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
