import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { verifyCronSecret } from '@/lib/auth';
import { reportingWeek } from '@/lib/week';
import {
  JOBS,
  dueAt,
  isDue,
  isPurgeDue,
  todayDateStr,
  decidePollAction,
  MAX_ATTEMPTS,
  STALE_RUNNING_MS,
  type CronJobDef,
  type CronRunStatus,
  type PollAction,
} from '@/lib/cron';
import { getSchedulerState, type SchedulerState } from '@/lib/scheduler-state';
import { legalFooterReady } from '@/lib/legal';

/**
 * Read-only operational snapshot for the founder's local monitor
 * (scripts/monitor.js). Nothing here writes.
 *
 * Guarded by CRON_SECRET, like /api/admin/plan and for the same reason: it is
 * an operator tool with no UI, and a second privileged auth scheme for one
 * route would be more surface than it removes.
 *
 * Failure policy is "degrade, don't 500": the monitor is most useful during an
 * outage, so a dead database must still yield the app/scheduler sections with
 * db.ok=false rather than an opaque error. The DB ping runs first; if it fails
 * the data sections are null and nothing else is queried. If the ping passes
 * but one section's SQL fails, that section is null and errors[] says why.
 */
export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PipelineJob {
  job: string;
  /** cron_runs.week_of this job is keyed by: Monday for weekly jobs, today for purge. */
  keyedBy: string;
  /** ISO instant the weekly job becomes due; null for purge (time-of-day gate only). */
  dueAt: string | null;
  due: boolean;
  action: PollAction;
  /** null = no cron_runs row exists yet for this key. */
  status: CronRunStatus | null;
  attempts: number | null;
  ranAt: string | null;
  finishedAt: string | null;
  processed: number | null;
  failed: number | null;
  error: string | null;
}

export interface PipelineSection {
  weekOf: string;
  today: string;
  maxAttempts: number;
  staleRunningMs: number;
  jobs: PipelineJob[];
}

export interface ActivitySection {
  orgs: { total: number; connected: number; paid: number; pendingDeletion: number };
  logins: { last24h: number; last7d: number };
  loginLinks: { requested24h: number; used24h: number };
  surveys: { respondedToday: number; responded7d: number; awaitingEmail: number };
  digestSendsThisWeek: number;
  unsubscribesTotal: number;
}

export interface StatusResponse {
  generatedAt: string;
  app: {
    uptimeSec: number;
    nodeVersion: string;
    rssMb: number;
    commit: string | null;
    environment: string | null;
  };
  db: { ok: boolean; latencyMs: number | null; error?: string };
  scheduler: SchedulerState;
  pipeline: PipelineSection | null;
  activity: ActivitySection | null;
  legal: { footerReady: boolean };
  errors: string[];
}

interface CronRunRow {
  job: string;
  status: CronRunStatus;
  attempts: number;
  ran_at: Date;
  finished_at: Date | null;
  processed: number;
  failed: number;
  error: string | null;
}

function json(body: StatusResponse | { error: string }, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

async function pingDb(): Promise<StatusResponse['db']> {
  const started = Date.now();
  try {
    await queryOne('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: null, error: errorMessage(err) };
  }
}

function toJobState(
  job: string,
  keyedBy: string,
  dueAtValue: Date | null,
  due: boolean,
  row: CronRunRow | undefined,
  now: Date,
): PipelineJob {
  const record = row ? { status: row.status, ranAt: new Date(row.ran_at), attempts: row.attempts } : null;
  // Mirror the poll loop exactly: it checks isDue/isPurgeDue before it ever
  // consults cron_runs, so a not-yet-due job is 'skip' no matter what the
  // record says. Without this gate the monitor would announce "call" for
  // every job at 02:00 Monday when the scheduler is going to do nothing.
  const action: PollAction = due
    ? decidePollAction(record, now, { maxAttempts: MAX_ATTEMPTS, staleRunningMs: STALE_RUNNING_MS })
    : 'skip';
  return {
    job,
    keyedBy,
    dueAt: iso(dueAtValue),
    due,
    action,
    status: row?.status ?? null,
    attempts: row?.attempts ?? null,
    ranAt: iso(row?.ran_at),
    finishedAt: iso(row?.finished_at),
    processed: row?.processed ?? null,
    failed: row?.failed ?? null,
    error: row?.error ?? null,
  };
}

async function loadPipeline(now: Date, weekOfStr: string): Promise<PipelineSection> {
  const today = todayDateStr(now);
  // week_of is deliberately not selected: node-postgres parses a bare `date`
  // into a local-midnight Date, and the key is already known from the WHERE.
  const rows = await query<CronRunRow>(
    `SELECT job, status, attempts, ran_at, finished_at, processed, failed, error
     FROM cron_runs
     WHERE (job = ANY($1::text[]) AND week_of = $2::date)
        OR (job = 'purge' AND week_of = $3::date)`,
    [JOBS.map((j) => j.job), weekOfStr, today],
  );
  const byJob = new Map(rows.map((r) => [r.job, r]));

  const weekly = JOBS.map((def: CronJobDef) =>
    toJobState(def.job, weekOfStr, dueAt(def, now), isDue(def, now), byJob.get(def.job), now),
  );
  const purge = toJobState('purge', today, null, isPurgeDue(now), byJob.get('purge'), now);

  return { weekOf: weekOfStr, today, maxAttempts: MAX_ATTEMPTS, staleRunningMs: STALE_RUNNING_MS, jobs: [...weekly, purge] };
}

async function loadActivity(now: Date, weekOfStr: string): Promise<ActivitySection> {
  // Every boundary is computed here in UTC and passed in, never `now()::date`
  // in SQL, so the database session's timezone can't move "today".
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();

  const [orgs, links, surveys, digests, unsubscribes] = await Promise.all([
    queryOne<{
      total: number;
      connected: number;
      paid: number;
      pending_deletion: number;
      logins_24h: number;
      logins_7d: number;
    }>(
      `SELECT count(*)::int                                                  AS total,
              count(*) FILTER (WHERE stripe_api_key_enc IS NOT NULL)::int    AS connected,
              count(*) FILTER (WHERE plan <> 'free')::int                    AS paid,
              count(*) FILTER (WHERE deletion_requested_at IS NOT NULL)::int AS pending_deletion,
              count(*) FILTER (WHERE last_login_at >= $1::timestamptz)::int  AS logins_24h,
              count(*) FILTER (WHERE last_login_at >= $2::timestamptz)::int  AS logins_7d
       FROM organizations`,
      [dayAgo, weekAgo],
    ),
    queryOne<{ requested_24h: number; used_24h: number }>(
      `SELECT count(*) FILTER (WHERE created_at >= $1::timestamptz)::int AS requested_24h,
              count(*) FILTER (WHERE used_at    >= $1::timestamptz)::int AS used_24h
       FROM login_tokens`,
      [dayAgo],
    ),
    // awaiting_email mirrors the Stripe webhook's re-send claim: sent_at was
    // added by a later migration, so "sent_at IS NULL" alone would also count
    // legacy rows whose survey was already answered.
    queryOne<{ responded_today: number; responded_7d: number; awaiting_email: number }>(
      `SELECT count(*) FILTER (WHERE surveyed_at >= $1::timestamptz)::int AS responded_today,
              count(*) FILTER (WHERE surveyed_at >= $2::timestamptz)::int AS responded_7d,
              count(*) FILTER (WHERE survey_email_sent_at IS NULL
                                 AND surveyed_at IS NULL
                                 AND token IS NOT NULL)::int              AS awaiting_email
       FROM survey_responses
       WHERE is_test = false`,
      [todayStart, weekAgo],
    ),
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM digest_sends WHERE week_of = $1::date`,
      [weekOfStr],
    ),
    queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM unsubscribes`),
  ]);

  // Aggregates always return one row; a null here means the mocked/failed
  // boundary returned nothing, which is a bug worth surfacing, not zeroing.
  if (!orgs || !links || !surveys || !digests || !unsubscribes) {
    throw new Error('activity query returned no row');
  }

  return {
    orgs: {
      total: orgs.total,
      connected: orgs.connected,
      paid: orgs.paid,
      pendingDeletion: orgs.pending_deletion,
    },
    logins: { last24h: orgs.logins_24h, last7d: orgs.logins_7d },
    loginLinks: { requested24h: links.requested_24h, used24h: links.used_24h },
    surveys: {
      respondedToday: surveys.responded_today,
      responded7d: surveys.responded_7d,
      awaitingEmail: surveys.awaiting_email,
    },
    digestSendsThisWeek: digests.count,
    unsubscribesTotal: unsubscribes.count,
  };
}

export async function GET(req: Request) {
  if (!verifyCronSecret(req.headers.get('authorization'))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const now = new Date();
  const { weekOfStr } = reportingWeek(now);
  const errors: string[] = [];

  const db = await pingDb();

  let pipeline: PipelineSection | null = null;
  let activity: ActivitySection | null = null;
  if (db.ok) {
    const [pipelineResult, activityResult] = await Promise.allSettled([
      loadPipeline(now, weekOfStr),
      loadActivity(now, weekOfStr),
    ]);
    if (pipelineResult.status === 'fulfilled') pipeline = pipelineResult.value;
    else errors.push(`pipeline: ${errorMessage(pipelineResult.reason)}`);
    if (activityResult.status === 'fulfilled') activity = activityResult.value;
    else errors.push(`activity: ${errorMessage(activityResult.reason)}`);
  }

  return json({
    generatedAt: now.toISOString(),
    app: {
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? null,
    },
    db,
    scheduler: getSchedulerState(),
    pipeline,
    activity,
    legal: { footerReady: legalFooterReady() },
    errors,
  });
}
