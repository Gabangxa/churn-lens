import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const queryOneMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

import { claimCronRun, dueAt, isDue, JOBS } from '../cron';

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
