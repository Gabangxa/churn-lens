import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const queryOneMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

import {
  claimCronRun,
  cronRunRecord,
  cronRunStatus,
  dueAt,
  finishCronRun,
  isDue,
  JOBS,
} from '../cron';

const THEMES_JOB = JOBS.find((j) => j.job === 'themes')!;
const DIGEST_JOB = JOBS.find((j) => j.job === 'digest')!;

beforeEach(() => {
  queryMock.mockReset();
  queryOneMock.mockReset();
  executeMock.mockReset();
});

describe('claimCronRun', () => {
  it('returns true when the INSERT/UPDATE returns a row', async () => {
    queryMock.mockResolvedValue([{ job: 'themes' }]);
    expect(await claimCronRun('themes', '2026-03-09')).toBe(true);
  });

  it('returns false when the ON CONFLICT branch matches nothing (already succeeded)', async () => {
    queryMock.mockResolvedValue([]);
    expect(await claimCronRun('themes', '2026-03-09')).toBe(false);
  });

  it('runs one statement with a reclaim guard for failed and stale-running rows', async () => {
    queryMock.mockResolvedValue([{ job: 'digest' }]);
    await claimCronRun('digest', '2026-03-09');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0] as string;
    const params = queryMock.mock.calls[0][1] as unknown[];

    expect(sql).toContain("ON CONFLICT (job, week_of) DO UPDATE");
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("status = 'running' AND cron_runs.ran_at < now() - interval '2 hours'");
    expect(params).toEqual(['digest', '2026-03-09']);
  });
});

describe('dueAt / isDue', () => {
  it('themes is not due at Monday 05:59 UTC', () => {
    const now = new Date('2026-03-16T05:59:00Z');
    expect(isDue(THEMES_JOB, now)).toBe(false);
  });

  it('themes is due at Monday 06:00 UTC', () => {
    const now = new Date('2026-03-16T06:00:00Z');
    expect(isDue(THEMES_JOB, now)).toBe(true);
  });

  it('themes is still due on Tuesday of the same reporting week', () => {
    const now = new Date('2026-03-17T12:00:00Z');
    expect(isDue(THEMES_JOB, now)).toBe(true);
    expect(dueAt(THEMES_JOB, now).toISOString()).toBe(dueAt(THEMES_JOB, new Date('2026-03-16T06:00:00Z')).toISOString());
  });

  it('themes is still due the following Sunday 23:59 UTC for that same week', () => {
    // The Sunday that ends the reporting week started by Monday 2026-03-16.
    const now = new Date('2026-03-22T23:59:00Z');
    expect(isDue(THEMES_JOB, now)).toBe(true);
  });

  it('digest is due at 07:00 UTC, not 06:00', () => {
    const notYet = new Date('2026-03-16T06:30:00Z');
    const due = new Date('2026-03-16T07:00:00Z');
    expect(isDue(DIGEST_JOB, notYet)).toBe(false);
    expect(isDue(DIGEST_JOB, due)).toBe(true);
  });
});

describe('claimCronRun — reclaim contract', () => {
  it('never reclaims a succeeded week', async () => {
    queryMock.mockResolvedValue([]);
    await claimCronRun('themes', '2026-03-09');
    const sql = queryMock.mock.calls[0][0] as string;

    // The only statuses the guard may match are 'failed' and stale 'running'.
    // If 'succeeded' ever appears in the WHERE, a finished week would replay
    // and re-spend OpenAI tokens / re-email founders.
    const where = sql.slice(sql.indexOf('WHERE'));
    expect(where).not.toContain('succeeded');
  });

  it('resets the run bookkeeping on a reclaim so the retry starts clean', async () => {
    queryMock.mockResolvedValue([{ job: 'themes' }]);
    await claimCronRun('themes', '2026-03-09');
    const sql = queryMock.mock.calls[0][0] as string;

    expect(sql).toContain("status = 'running'");
    expect(sql).toContain('ran_at = now()');
    expect(sql).toContain('finished_at = NULL');
    expect(sql).toContain('error = NULL');
    expect(sql).toContain('attempts = cron_runs.attempts + 1');
  });

  it('inserts a fresh row as running', async () => {
    queryMock.mockResolvedValue([{ job: 'themes' }]);
    await claimCronRun('themes', '2026-03-09');
    const sql = queryMock.mock.calls[0][0] as string;

    expect(sql).toContain('INSERT INTO cron_runs (job, week_of, status)');
    expect(sql).toContain("VALUES ($1, $2, 'running')");
    expect(sql).toContain('RETURNING job');
  });

  it('propagates a DB failure instead of silently reporting "not claimed"', async () => {
    // Swallowing this would return false, which the routes read as "someone
    // else has it" — the week would be quietly skipped rather than retried.
    queryMock.mockRejectedValue(new Error('connection terminated'));
    await expect(claimCronRun('themes', '2026-03-09')).rejects.toThrow('connection terminated');
  });
});

describe('finishCronRun', () => {
  it('writes status, counts and finished_at for a succeeded run', async () => {
    executeMock.mockResolvedValue(1);
    await finishCronRun('themes', '2026-03-09', { status: 'succeeded', processed: 4, failed: 0 });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [sql, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE cron_runs');
    expect(sql).toContain('finished_at = now()');
    expect(params).toEqual(['succeeded', 4, 0, null, 'themes', '2026-03-09']);
  });

  it('stores the error message for a failed run', async () => {
    executeMock.mockResolvedValue(1);
    await finishCronRun('digest', '2026-03-09', {
      status: 'failed',
      processed: 2,
      failed: 1,
      error: 'resend 500',
    });

    const params = executeMock.mock.calls[0][1] as unknown[];
    expect(params).toEqual(['failed', 2, 1, 'resend 500', 'digest', '2026-03-09']);
  });

  it('scopes the update to the (job, week) pair, never a bare job match', async () => {
    executeMock.mockResolvedValue(1);
    await finishCronRun('digest', '2026-03-09', { status: 'succeeded', processed: 0, failed: 0 });
    const sql = executeMock.mock.calls[0][0] as string;
    expect(sql).toContain('WHERE job = $5 AND week_of = $6');
  });
});

describe('cronRunStatus', () => {
  it('returns null when the week has never run', async () => {
    queryOneMock.mockResolvedValue(null);
    expect(await cronRunStatus('themes', '2026-03-09')).toBeNull();
  });

  it('returns the stored status', async () => {
    queryOneMock.mockResolvedValue({ status: 'failed' });
    expect(await cronRunStatus('themes', '2026-03-09')).toBe('failed');
  });

  it('queries by job and week', async () => {
    queryOneMock.mockResolvedValue({ status: 'succeeded' });
    await cronRunStatus('themes', '2026-03-09');
    const [sql, params] = queryOneMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SELECT status FROM cron_runs WHERE job = $1 AND week_of = $2');
    expect(params).toEqual(['themes', '2026-03-09']);
  });
});

describe('cronRunRecord', () => {
  it('returns null when the week has never run', async () => {
    queryOneMock.mockResolvedValue(null);
    expect(await cronRunRecord('themes', '2026-03-09')).toBeNull();
  });

  it('parses ran_at into a Date the scheduler can compare against now', async () => {
    queryOneMock.mockResolvedValue({
      status: 'running',
      ran_at: '2026-03-16T06:00:00.000Z',
      attempts: 3,
    });

    const record = await cronRunRecord('themes', '2026-03-09');
    expect(record).not.toBeNull();
    expect(record!.status).toBe('running');
    expect(record!.attempts).toBe(3);
    expect(record!.ranAt).toBeInstanceOf(Date);
    expect(record!.ranAt.toISOString()).toBe('2026-03-16T06:00:00.000Z');
  });

  it('selects the attempts column the retry cap depends on', async () => {
    queryOneMock.mockResolvedValue(null);
    await cronRunRecord('digest', '2026-03-09');
    const sql = queryOneMock.mock.calls[0][0] as string;
    expect(sql).toContain('SELECT status, ran_at, attempts FROM cron_runs');
  });
});

describe('dueAt / isDue — week boundary', () => {
  // 2026-03-15 is a Sunday; 2026-03-16 the Monday that follows it.
  it('Sunday 23:59 UTC is not yet due for the week the next Monday opens', () => {
    const sundayNight = new Date('2026-03-15T23:59:00Z');

    // The job is "due" — but for the *previous* reporting week (week_of
    // 2026-03-02, whose Monday was 2026-03-09), not for the one that starts
    // hours later. A poll at this instant must not fire the new week early.
    expect(dueAt(THEMES_JOB, sundayNight).toISOString()).toBe('2026-03-09T06:00:00.000Z');
    expect(dueAt(THEMES_JOB, sundayNight).getTime()).toBeLessThan(
      new Date('2026-03-16T06:00:00Z').getTime(),
    );
  });

  it('Monday 06:00 UTC rolls dueAt onto the new week and is due', () => {
    const monday = new Date('2026-03-16T06:00:00Z');
    expect(dueAt(THEMES_JOB, monday).toISOString()).toBe('2026-03-16T06:00:00.000Z');
    expect(isDue(THEMES_JOB, monday)).toBe(true);
  });

  it('the new week is not due in the gap between Monday 00:00 and 06:00', () => {
    const mondayEarly = new Date('2026-03-16T00:00:00Z');
    expect(dueAt(THEMES_JOB, mondayEarly).toISOString()).toBe('2026-03-16T06:00:00.000Z');
    expect(isDue(THEMES_JOB, mondayEarly)).toBe(false);
    expect(isDue(DIGEST_JOB, mondayEarly)).toBe(false);
  });

  it('digest is due exactly one hour after themes, every week', () => {
    const HOUR_MS = 60 * 60 * 1000;
    for (const iso of [
      '2026-03-16T06:00:00Z',
      '2026-03-18T13:37:00Z',
      '2026-03-22T23:59:00Z',
      '2026-12-28T09:00:00Z',
      '2027-01-04T06:00:00Z',
    ]) {
      const now = new Date(iso);
      expect(dueAt(DIGEST_JOB, now).getTime() - dueAt(THEMES_JOB, now).getTime()).toBe(HOUR_MS);
    }
  });

  it('digest is still not due at Monday 06:59:59 UTC', () => {
    expect(isDue(DIGEST_JOB, new Date('2026-03-16T06:59:59Z'))).toBe(false);
  });

  it('dueAt does not mutate the caller’s Date', () => {
    const now = new Date('2026-03-18T13:37:00Z');
    const before = now.toISOString();
    dueAt(THEMES_JOB, now);
    isDue(DIGEST_JOB, now);
    expect(now.toISOString()).toBe(before);
  });

  it('themes is listed before digest so a single poll can run them in order', () => {
    // The digest route defers until themes has succeeded; if the scheduler
    // asked for digest first on a catch-up poll it would always defer and
    // wait another 10 minutes.
    expect(JOBS.map((j) => j.job)).toEqual(['themes', 'digest']);
    expect(JOBS.map((j) => j.path)).toEqual(['/api/themes', '/api/digest']);
  });
});
