import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertThrowawayDatabase } from '../../../../../e2e/helpers/throwaway-db';

/**
 * POST /api/survey — a churned customer's one-shot answer — against a real
 * PostgreSQL.
 *
 * route.test.ts pins the caps and the reason handling against a mocked
 * `execute`; only a real engine can prove that what the route hands Postgres is
 * something Postgres will actually store. The case that matters is the NUL
 * byte: `text` cannot hold U+0000, so one NUL anywhere in an answer used to
 * fail the whole UPDATE — the answer was lost for good (the link is single-use)
 * and anyone holding a survey link could fire an operator alert at will.
 * Token signing and verification are the real module. Skipped unless
 * TEST_DATABASE_URL points at a migrated throwaway database.
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
import { signSurveyToken } from '@/lib/crypto';
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const APP_URL = 'https://app.churnlens.test';
const BUILTIN_REASON = 'Too expensive for my budget';

interface StoredAnswer {
  reason_category: string | null;
  open_text: string | null;
  comeback_text: string | null;
  surveyed_at: Date | null;
}

/** An org with one unanswered survey row; returns the signed token for it. */
async function seedPendingSurvey(): Promise<{ orgId: string; token: string }> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('db-suite org') RETURNING id`,
  );
  const orgId = rows[0].id;
  const token = signSurveyToken({
    orgId,
    customerId: `cus_${randomUUID()}`,
    subscriptionId: `sub_${randomUUID()}`,
    exp: Date.now() + 60 * 60 * 1000,
  });
  await pool().query(
    `INSERT INTO survey_responses (org_id, customer_email, stripe_subscription_id, token, mrr_lost)
     VALUES ($1, 'churned@example.com', $2, $3, 29)`,
    [orgId, `sub_${randomUUID()}`, token],
  );
  return { orgId, token };
}

async function storedAnswer(token: string): Promise<StoredAnswer> {
  const { rows } = await pool().query<StoredAnswer>(
    'SELECT reason_category, open_text, comeback_text, surveyed_at FROM survey_responses WHERE token = $1',
    [token],
  );
  return rows[0];
}

function submit(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return POST(new NextRequest(`${APP_URL}/api/survey`, { method: 'POST', body: form }));
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST /api/survey against a real database', () => {
  beforeAll(async () => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
    dbState.pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
    const { rows } = await pool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'survey_responses' AND column_name = 'survey_email_sent_at'`,
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
    vi.stubEnv('ENCRYPTION_KEY', 'e'.repeat(64));
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    resetErrorReports();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await pool().query('TRUNCATE organizations CASCADE');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('stores an answer typed with NUL bytes in every field, minus the NULs, and reports nothing', async () => {
    const { token } = await seedPendingSurvey();

    const res = await submit({
      token,
      reason: `${BUILTIN_REASON}\u0000`,
      open_text: 'the export\u0000 kept failing',
      comeback_text: '\u0000a cheaper tier',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/survey/thanks`);
    const stored = await storedAnswer(token);
    expect(stored).toMatchObject({
      reason_category: BUILTIN_REASON,
      open_text: 'the export kept failing',
      comeback_text: 'a cheaper tier',
    });
    expect(stored.surveyed_at).not.toBeNull();
    // A stranger with a survey link must not be able to page the operator.
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('keeps the line breaks and tabs a customer actually typed', async () => {
    const { token } = await seedPendingSurvey();

    // CRLF: multipart form encoding normalises every line break to it anyway.
    const res = await submit({ token, reason: BUILTIN_REASON, open_text: 'first line\r\nsecond\tline' });

    expect(res.status).toBe(303);
    expect((await storedAnswer(token)).open_text).toBe('first line\r\nsecond\tline');
  });
});
