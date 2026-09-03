import { query, queryOne, execute } from '@/lib/db';
import { reportingWeek } from '@/lib/week';

export type CronRunStatus = 'running' | 'succeeded' | 'failed';

/**
 * A week stuck retrying past this many attempts is treated as broken, not
 * transient. Exported so both the scheduler (decidePollAction, below) and
 * routes that need to know "has themes given up on this week" (the digest
 * gate in src/app/api/digest/route.ts) share one number instead of drifting.
 */
export const MAX_ATTEMPTS = 5;

/**
 * A 'running' row older than this is presumed crashed (the process that
 * claimed it died before calling finishCronRun) rather than still in flight.
 * Shared between claimCronRun's SQL and the scheduler's decidePollAction so
 * the two can never disagree about which running rows are reclaimable.
 */
export const STALE_RUNNING_MS = 2 * 60 * 60 * 1000; // 2 hours

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
 *     ran_at > STALE_RUNNING_MS old -> treated as crashed (process died
 *                              mid-run, never got to call finishCronRun) and
 *                              reclaimed.
 *   - status='running' and
 *     ran_at <= STALE_RUNNING_MS    -> another instance is plausibly still
 *                              working this week; caller loses.
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
          OR (cron_runs.status = 'running' AND cron_runs.ran_at < now() - ($3 || ' milliseconds')::interval)
     RETURNING job`,
    [job, weekOfStr, STALE_RUNNING_MS],
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
 * callers that only care about succeeded/not-succeeded. Also used by the
 * digest route, which needs `attempts` to tell "themes is still retrying"
 * apart from "themes has given up" (both report status='failed').
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

export type PollAction = 'skip' | 'call' | 'exhausted';

/**
 * Pure decision of what the scheduler should do about one (job, week) this
 * poll, given its cron_runs record. Kept separate from instrumentation.ts so
 * it can be table-tested without fake-timer/fetch scaffolding.
 *
 *   - No record yet             -> 'call' (never run).
 *   - status='succeeded'        -> 'skip' (done, forever).
 *   - attempts >= maxAttempts   -> 'exhausted', REGARDLESS of status. This
 *     must be checked before the status-specific branches below: a job that
 *     crashes every time it's claimed never reaches finishCronRun, so it
 *     never becomes 'failed' — it just cycles through stale 'running' rows,
 *     each reclaim bumping attempts. Checking the cap only under `status ===
 *     'failed'` (the original bug) would let that case retry forever.
 *   - status='running'          -> 'call' only once the row is older than
 *     staleRunningMs (presumed crashed); otherwise 'skip' (still in flight).
 *   - status='failed'           -> exponential backoff: 'call' once
 *     `now - ranAt >= min(30min * 2^(attempts-1), 8h)`, else 'skip'. Without
 *     this, 5 attempts at a fixed 10-minute poll cadence burn the whole
 *     retry budget in under an hour on Monday morning.
 */
export function decidePollAction(
  record: CronRunRecord | null,
  now: Date,
  opts: { maxAttempts: number; staleRunningMs: number },
): PollAction {
  if (!record) return 'call';
  if (record.status === 'succeeded') return 'skip';

  if (record.attempts >= opts.maxAttempts) return 'exhausted';

  const elapsedMs = now.getTime() - record.ranAt.getTime();

  if (record.status === 'running') {
    return elapsedMs >= opts.staleRunningMs ? 'call' : 'skip';
  }

  // status === 'failed'
  const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
  const THIRTY_MIN_MS = 30 * 60 * 1000;
  const backoffMs = Math.min(THIRTY_MIN_MS * 2 ** (record.attempts - 1), EIGHT_HOURS_MS);
  return elapsedMs >= backoffMs ? 'call' : 'skip';
}
