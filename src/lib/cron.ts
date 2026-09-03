import { query, queryOne, execute } from '@/lib/db';
import { reportingWeek } from '@/lib/week';

export type CronRunStatus = 'running' | 'succeeded' | 'failed';

/**
 * Claim a week's cron run atomically.
 *
 * The plain `INSERT ... ON CONFLICT DO NOTHING` this replaced only ever
 * claimed a week once, forever — an exception mid-run left the row stuck at
 * "claimed" with no way to distinguish it from a real success, so that week
 * could never be retried. This does the claim and the "is it retryable"
 * decision in one statement so there is no window where two concurrent
 * callers could both see the row as reclaimable:
 *
 *   - No row yet            -> INSERT wins, status='running', attempts=1.
 *   - status='succeeded'    -> WHERE excludes it; no update; caller loses.
 *   - status='failed'       -> reclaimed for a retry (attempts+1).
 *   - status='running' and
 *     ran_at > 2h old       -> treated as crashed (process died mid-run,
 *                              never got to call finishCronRun) and reclaimed.
 *   - status='running' and
 *     ran_at <= 2h old      -> another instance is plausibly still working
 *                              this week; caller loses.
 *
 * Returns true iff this call won the claim and should do the work.
 */
export async function claimCronRun(job: string, weekOfStr: string): Promise<boolean> {
  const rows = await query<{ job: string }>(
    `INSERT INTO cron_runs (job, week_of, status)
     VALUES ($1, $2, 'running')
     ON CONFLICT (job, week_of) DO UPDATE
       SET status = 'running',
           ran_at = now(),
           finished_at = NULL,
           error = NULL,
           attempts = cron_runs.attempts + 1
       WHERE cron_runs.status = 'failed'
          OR (cron_runs.status = 'running' AND cron_runs.ran_at < now() - interval '2 hours')
     RETURNING job`,
    [job, weekOfStr],
  );
  return rows.length > 0;
}

/** Record the outcome of a claimed run. Always call this once you've claimed. */
export async function finishCronRun(
  job: string,
  weekOfStr: string,
  result: {
    status: 'succeeded' | 'failed';
    processed: number;
    failed: number;
    error?: string;
  },
): Promise<void> {
  await execute(
    `UPDATE cron_runs
     SET status = $1, finished_at = now(), processed = $2, failed = $3, error = $4
     WHERE job = $5 AND week_of = $6`,
    [result.status, result.processed, result.failed, result.error ?? null, job, weekOfStr],
  );
}

/** Current status for a (job, week), or null if it has never run. */
export async function cronRunStatus(job: string, weekOfStr: string): Promise<CronRunStatus | null> {
  const row = await queryOne<{ status: CronRunStatus }>(
    `SELECT status FROM cron_runs WHERE job = $1 AND week_of = $2`,
    [job, weekOfStr],
  );
  return row?.status ?? null;
}

export interface CronRunRecord {
  status: CronRunStatus;
  ranAt: Date;
  attempts: number;
}

/**
 * Fuller read used by the scheduler, which needs `attempts` (to stop retrying
 * a permanently-broken week) and `ranAt` (to decide whether a 'running' row
 * looks crashed) — detail `cronRunStatus` deliberately doesn't expose to route
 * callers that only care about succeeded/not-succeeded.
 */
export async function cronRunRecord(job: string, weekOfStr: string): Promise<CronRunRecord | null> {
  const row = await queryOne<{ status: CronRunStatus; ran_at: string; attempts: number }>(
    `SELECT status, ran_at, attempts FROM cron_runs WHERE job = $1 AND week_of = $2`,
    [job, weekOfStr],
  );
  if (!row) return null;
  return { status: row.status, ranAt: new Date(row.ran_at), attempts: row.attempts };
}

export interface CronJobDef {
  job: string;
  path: string;
  hourUtc: number;
}

/** The two weekly jobs and the hour (UTC) each is due, on the Monday the reporting week ends. */
export const JOBS: CronJobDef[] = [
  { job: 'themes', path: '/api/themes', hourUtc: 6 },
  { job: 'digest', path: '/api/digest', hourUtc: 7 },
];

/**
 * The instant a job becomes due for the reporting week that `now` falls in:
 * the Monday that week ends (reportingWeek(now).weekEnd), at the job's hour.
 * Stable across the whole week that follows that Monday — i.e. dueAt doesn't
 * "expire" at end of day, so a poll any time before next Monday still sees
 * this week as due until it actually succeeds.
 */
export function dueAt(job: CronJobDef, now: Date = new Date()): Date {
  const { weekEnd } = reportingWeek(now);
  const due = new Date(weekEnd);
  due.setUTCHours(job.hourUtc, 0, 0, 0);
  return due;
}

export function isDue(job: CronJobDef, now: Date = new Date()): boolean {
  return now.getTime() >= dueAt(job, now).getTime();
}
