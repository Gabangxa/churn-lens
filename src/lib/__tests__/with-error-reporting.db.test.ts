import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

/**
 * Which Postgres failures withErrorReporting treats as the CALLER's bad input
 * (400, a warning, no alert) and which as ours (500, reported, alerted) —
 * decided by SQLSTATE, so the errors here come from a real engine rather than
 * hand-built objects with a `code`. Each handler binds a request-supplied
 * value exactly the way a route would. Read-only: nothing is written.
 * Skipped unless TEST_DATABASE_URL is set.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

import { withErrorReporting } from '../with-error-reporting';
import { getErrorReportSnapshot, resetErrorReports } from '../report-error';

let pool: Pool | null = null;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** A route that casts one request-supplied value in SQL, like `WHERE id = $1` on a uuid column. */
function castingRoute(sql: string) {
  return withErrorReporting(
    'test.lookup',
    async (_req: NextRequest, { params }: { params: { value: string } }) => {
      await pool!.query(sql, [params.value]);
      return NextResponse.json({ ok: true });
    },
  );
}

function call(sql: string, value: string) {
  return castingRoute(sql)(new NextRequest('https://app.churnlens.test/api/lookup', { method: 'POST' }), {
    params: { value },
  });
}

function warnLines(): Record<string, unknown>[] {
  return warnSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('withErrorReporting — Postgres data exceptions against a real database', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, ssl: false });
  });

  afterAll(async () => {
    await pool?.end();
    pool = null;
  });

  beforeEach(() => {
    resetErrorReports();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['22P02', 'a malformed uuid', 'SELECT $1::uuid', 'not-a-uuid'],
    ['22021', 'a NUL byte in text', 'SELECT $1::text', 'before\u0000after'],
    ['22P05', 'a NUL escape inside jsonb', 'SELECT $1::jsonb', JSON.stringify({ name: 'a\u0000b' })],
    ['22003', 'an out-of-range integer', 'SELECT $1::int4', '99999999999'],
    ['22007', 'a malformed timestamp', 'SELECT $1::timestamptz', 'next tuesday-ish'],
  ])('%s (%s) answers 400 and warns, without reporting or alerting', async (code, _label, sql, value) => {
    const res = await call(sql, value);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(getErrorReportSnapshot().totalReported).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnLines()).toEqual([
      expect.objectContaining({ level: 'warn', context: 'test.lookup', code, meta: { method: 'POST', value: expect.any(String) } }),
    ]);
  });

  it('keeps an address quoted back by Postgres out of the warning', async () => {
    // "invalid input syntax for type uuid: "jane@customer.example""
    await call('SELECT $1::uuid', 'jane@customer.example');

    const raw = warnSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(raw).toContain('[redacted email]');
    expect(raw).not.toContain('jane');
  });

  it('still reports the rest of the data-exception class: division by zero is our arithmetic, not their input', async () => {
    const res = await call('SELECT 1 / $1::int', '0');

    expect(res.status).toBe(500);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'test.lookup', message: 'division by zero', meta: expect.objectContaining({ step: 'unhandled' }) }),
    ]);
  });

  it('still reports a query that is simply wrong', async () => {
    const res = await call('SELECT $1::text FROM no_such_table', 'x');

    expect(res.status).toBe(500);
    expect(getErrorReportSnapshot().totalReported).toBe(1);
  });
});
