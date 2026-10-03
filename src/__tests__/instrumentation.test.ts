import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `src/instrumentation.ts` exports only `register()` — the poll loop, the
 * attempts cap and the stale-run back-off all live in closures inside it. They
 * are still the part worth testing (they decide whether a founder's digest is
 * retried, skipped, or hammered every 10 minutes), so these tests drive the
 * real `register()` with fake timers and stub only the two genuine boundaries
 * it depends on: `cronRunRecord` (Postgres) and `fetch` (the HTTP call to the
 * route). Due-time maths, JOBS and reportingWeek are the real implementations.
 */

const validateEnvMock = vi.fn();
vi.mock('../lib/env', () => ({ validateEnv: (...args: unknown[]) => validateEnvMock(...args) }));

const cronRunRecordMock = vi.fn();
vi.mock('../lib/cron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cron')>();
  return { ...actual, cronRunRecord: (...args: unknown[]) => cronRunRecordMock(...args) };
});

import { register } from '../instrumentation';
import { getSchedulerState, resetSchedulerState } from '../lib/scheduler-state';
// Real, not mocked: these tests assert on what reportError recorded. ALERT_EMAIL
// is pinned empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '../lib/report-error';

const FIRST_POLL_MS = 30 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;
const APP_URL = 'https://app.churnlens.test';

// Monday 2026-03-16 08:00 UTC — past both 06:00 (themes) and 07:00 (digest),
// so on a clean fixture both jobs are due for week_of 2026-03-09.
const MONDAY_0800 = new Date('2026-03-16T08:00:00Z');
const WEEK_OF = '2026-03-09';

let fetchMock: ReturnType<typeof vi.fn>;

function okResponse() {
  return { ok: true, status: 200, json: async () => ({ processed: 1 }), text: async () => '' };
}

function calledPaths(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url).replace(APP_URL, ''));
}

type Rec = { status: 'running' | 'succeeded' | 'failed'; ranAt: Date; attempts: number } | null;

// Purge is a third, independent job on the same scheduler (see
// src/instrumentation.ts) with its own daily due-check (isPurgeDue), so it is
// "due" at essentially every system time this file exercises (all well past
// 03:00 UTC). Defaulting it to already-succeeded here means every test written
// before purge existed keeps meaning exactly what it says — "themes" and
// "digest" behavior — without also having to account for a third fetch call.
// Tests that actually exercise purge (see 'register — purge' below) pass an
// explicit `purge` record to override this.
const PURGE_INERT: Rec = { status: 'succeeded', ranAt: MONDAY_0800, attempts: 1 };

function stubCronRunRecord(records: { themes?: Rec; digest?: Rec; purge?: Rec } = {}) {
  cronRunRecordMock.mockImplementation(async (job: string) => {
    if (job === 'purge') return records.purge !== undefined ? records.purge : PURGE_INERT;
    if (job === 'themes') return records.themes !== undefined ? records.themes : null;
    if (job === 'digest') return records.digest !== undefined ? records.digest : null;
    return null;
  });
}

/** Applies the same record to both weekly jobs, leaving purge inert (unless overridden). */
function stubWeeklyRecord(record: Rec, purge?: Rec) {
  stubCronRunRecord({ themes: record, digest: record, purge });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY_0800);
  resetSchedulerState();
  // Also detaches the process listeners an earlier test's register() installed.
  resetErrorReports();

  validateEnvMock.mockReset();
  validateEnvMock.mockImplementation(() => {});
  cronRunRecordMock.mockReset();
  stubWeeklyRecord(null);

  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);

  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
  vi.stubEnv('CRON_SECRET', 'topsecret');

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  resetErrorReports();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Register the scheduler and run its first poll to completion. */
async function bootAndPoll() {
  await register();
  await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
}

describe('register — guards', () => {
  it('does nothing outside the nodejs runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    await bootAndPoll();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(validateEnvMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a validateEnv failure propagate instead of booting a half-configured scheduler', async () => {
    validateEnvMock.mockImplementation(() => {
      throw new Error('Missing required environment variables:\n  DATABASE_URL');
    });

    await expect(register()).rejects.toThrow('Missing required environment variables');

    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS + POLL_INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates env but schedules nothing when E2E_DISABLE_SCHEDULER=1', async () => {
    // The end-to-end suite sets this on the server it boots: the poll loop
    // would otherwise race its cron spec for the same cron_runs claims. A
    // misconfigured server must still refuse to boot, so validateEnv has to
    // have run before the early return.
    vi.stubEnv('E2E_DISABLE_SCHEDULER', '1');

    await bootAndPoll();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(validateEnvMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cronRunRecordMock).not.toHaveBeenCalled();
  });

  it('leaves the scheduler on for any other value of E2E_DISABLE_SCHEDULER', async () => {
    // Only the exact string '1' disables it — a stray "0"/"false"/"true" in a
    // deploy's variables must not silently stop the weekly jobs.
    vi.stubEnv('E2E_DISABLE_SCHEDULER', 'false');

    await bootAndPoll();

    expect(fetchMock).toHaveBeenCalled();
  });

  // There used to be a runtime "NEXT_PUBLIC_APP_URL or CRON_SECRET not set"
  // guard here with its own warning + early return. It was dead code: both
  // vars are in validateEnv's REQUIRED set (src/lib/env.ts), so a real boot
  // missing either throws above, in the test already covered, before this
  // point is ever reached. Removed along with the test that could only
  // exercise it by mocking validateEnv into silently accepting a
  // half-configured environment it would never accept for real.
});

describe('register — poll cadence', () => {
  it('does not poll immediately on boot', async () => {
    await register();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS - 1000);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('keeps polling every 10 minutes', async () => {
    stubWeeklyRecord(null);
    await bootAndPoll();
    const afterFirst = fetchMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetchMock.mock.calls.length).toBe(afterFirst * 2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetchMock.mock.calls.length).toBe(afterFirst * 3);
  });
});

describe('register — what the poll decides to call', () => {
  it('calls both endpoints, themes first, when neither has run this week', async () => {
    await bootAndPoll();

    expect(calledPaths()).toEqual(['/api/themes', '/api/digest']);
    expect(cronRunRecordMock).toHaveBeenCalledWith('themes', WEEK_OF);
    expect(cronRunRecordMock).toHaveBeenCalledWith('digest', WEEK_OF);
  });

  it('authenticates with the cron secret and uses POST', async () => {
    await bootAndPoll();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer topsecret');
  });

  it('calls nothing before Monday 06:00 UTC', async () => {
    vi.setSystemTime(new Date('2026-03-16T05:00:00Z'));

    await bootAndPoll();

    expect(fetchMock).not.toHaveBeenCalled();
    // Themes/digest aren't due yet at 05:00, so neither is even looked up.
    // Purge has its own, unrelated daily gate (03:00 UTC) and IS due at
    // 05:00 — it's still queried, just inert (stubbed succeeded above).
    expect(cronRunRecordMock).not.toHaveBeenCalledWith('themes', expect.anything());
    expect(cronRunRecordMock).not.toHaveBeenCalledWith('digest', expect.anything());
  });

  it('calls only themes between 06:00 and 07:00 UTC', async () => {
    vi.setSystemTime(new Date('2026-03-16T06:30:00Z'));

    await bootAndPoll();

    expect(calledPaths()).toEqual(['/api/themes']);
  });

  it('never calls a job whose week already succeeded', async () => {
    cronRunRecordMock.mockResolvedValue({
      status: 'succeeded',
      ranAt: new Date('2026-03-16T06:05:00Z'),
      attempts: 1,
    });

    await bootAndPoll();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not pile on a run that is still plausibly in flight', async () => {
    cronRunRecordMock.mockResolvedValue({
      status: 'running',
      ranAt: new Date('2026-03-16T07:30:00Z'), // 30 min old, under the 2h window
      attempts: 1,
    });

    await bootAndPoll();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reclaims a run whose process died mid-flight (running, older than 2h)', async () => {
    stubWeeklyRecord({
      status: 'running',
      ranAt: new Date('2026-03-16T05:00:00Z'), // 3h old
      attempts: 1,
    });

    await bootAndPoll();

    expect(calledPaths()).toEqual(['/api/themes', '/api/digest']);
  });

  it('retries a failed week once its backoff window has elapsed, while under the attempts cap', async () => {
    // attempts=4 backs off min(30min * 2^3, 8h) = 4h. ranAt is ~6h before the
    // poll, so the window has elapsed and the retry is due.
    stubWeeklyRecord({
      status: 'failed',
      ranAt: new Date('2026-03-16T02:00:00Z'),
      attempts: 4,
    });

    await bootAndPoll();

    expect(calledPaths()).toEqual(['/api/themes', '/api/digest']);
  });

  it('does not retry a failed week yet inside its backoff window, even under the attempts cap', async () => {
    // Same attempts=4 (4h backoff), but ranAt is only ~30 min before the poll —
    // well inside the window. Without backoff, 5 attempts at a fixed 10-minute
    // cadence would burn the whole retry budget in under an hour.
    cronRunRecordMock.mockResolvedValue({
      status: 'failed',
      ranAt: new Date('2026-03-16T07:30:00Z'),
      attempts: 4,
    });

    await bootAndPoll();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops retrying once a week has failed 5 times, and says so only once', async () => {
    stubWeeklyRecord({
      status: 'failed',
      ranAt: new Date('2026-03-16T06:05:00Z'),
      attempts: 5,
    });
    const error = console.error as unknown as ReturnType<typeof vi.fn>;

    await bootAndPoll();
    expect(fetchMock).not.toHaveBeenCalled();

    const afterFirstPoll = error.mock.calls.length;
    expect(afterFirstPoll).toBe(2); // one per job

    // A standing condition, not a new event: later polls must stay quiet.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(error.mock.calls.length).toBe(afterFirstPoll);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('register — endpoint failures do not kill the loop', () => {
  it('logs a non-2xx response body without parsing it as JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('json() must not be called on a non-ok response');
      },
      text: async () => 'Bad Gateway',
    });
    const error = console.error as unknown as ReturnType<typeof vi.fn>;

    await bootAndPoll();

    expect(error.mock.calls.flat().join(' ')).toContain('502');
    // The next poll still happens — a bad response is not fatal.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it('survives a rejected fetch (timeout/network) and polls again', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    await bootAndPoll();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('one job’s cron_runs read failure is logged and skipped, without taking the other job down or leaking a rejection', async () => {
    // Each job's evaluation now has its own try/catch, and the void poll call
    // itself has a `.catch()` — a DB blip on one job must be logged and
    // skipped, not crash the whole poll or escape as an unhandled rejection.
    const leaked: unknown[] = [];
    const priorListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason) => leaked.push(reason));

    try {
      // JOBS is [themes, digest], so this rejects only themes' lookup — the
      // first cronRunRecord call this poll.
      cronRunRecordMock.mockRejectedValueOnce(new Error('connection terminated'));
      const error = console.error as unknown as ReturnType<typeof vi.fn>;

      await bootAndPoll();

      // themes failed to evaluate and was skipped this poll; digest's
      // independent read succeeded, so digest still gets called in the SAME
      // poll rather than waiting for the next one.
      expect(calledPaths()).toEqual(['/api/digest']);
      expect(error.mock.calls.flat().join(' ')).toContain('connection terminated');

      // The interval survives, and the next poll retries themes from scratch.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(calledPaths()).toEqual(['/api/digest', '/api/themes', '/api/digest']);

      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(leaked).toEqual([]);
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const listener of priorListeners) {
        process.on('unhandledRejection', listener as (reason: unknown) => void);
      }
    }
  });

  it('dedupes the "themes not ready" digest deferral log across polls for the same week', async () => {
    // cronRunRecordMock stays at its default (null for both jobs, from
    // beforeEach), so both /api/themes and /api/digest get called every
    // poll — this test is about the LOG for digest's response body, not
    // about whether digest is due.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/digest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deferred: 'themes_not_ready', weekOf: WEEK_OF }),
          text: async () => '',
        };
      }
      return okResponse();
    });
    const log = console.log as unknown as ReturnType<typeof vi.fn>;
    // console.log's second argument is the parsed JSON object itself (not a
    // string), so counting matches means inspecting that object directly —
    // `.join(' ')` would just stringify it to "[object Object]".
    const deferredLogCount = () =>
      log.mock.calls.filter(
        ([, body]) => (body as { deferred?: string } | undefined)?.deferred === 'themes_not_ready',
      ).length;

    await bootAndPoll();
    expect(deferredLogCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const deferredLogsAfterMore = deferredLogCount();
    // Still just the one log line — the deferral itself keeps being polled
    // for (the endpoint is still called every 10 minutes), it just isn't
    // re-logged once we've said it.
    expect(deferredLogsAfterMore).toBe(1);
  });
});

describe('register — purge', () => {
  const DATE_STR = '2026-03-16'; // todayDateStr(MONDAY_0800)

  it('is not queried at all before its 03:00 UTC daily gate', async () => {
    vi.setSystemTime(new Date('2026-03-16T02:59:00Z'));
    stubWeeklyRecord({ status: 'succeeded', ranAt: new Date('2026-03-09T06:05:00Z'), attempts: 1 });

    await bootAndPoll();

    expect(cronRunRecordMock).not.toHaveBeenCalledWith('purge', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/purge'), expect.anything());
  });

  it('is called once past 03:00 UTC when it has never run today', async () => {
    // Weekly jobs both already succeeded this week, so the only fetch left
    // this poll is purge — isolates the assertion to purge alone.
    stubWeeklyRecord(
      { status: 'succeeded', ranAt: new Date('2026-03-09T06:05:00Z'), attempts: 1 },
      null, // purge: never run
    );

    await bootAndPoll();

    expect(calledPaths()).toEqual(['/api/purge']);
    expect(cronRunRecordMock).toHaveBeenCalledWith('purge', DATE_STR);
  });

  it('is not called again once today’s run has succeeded', async () => {
    stubWeeklyRecord(
      { status: 'succeeded', ranAt: new Date('2026-03-09T06:05:00Z'), attempts: 1 },
      { status: 'succeeded', ranAt: MONDAY_0800, attempts: 1 },
    );

    await bootAndPoll();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reclaims a stale running purge row the same way the weekly jobs do', async () => {
    stubWeeklyRecord(
      { status: 'succeeded', ranAt: new Date('2026-03-09T06:05:00Z'), attempts: 1 },
      { status: 'running', ranAt: new Date('2026-03-16T05:00:00Z'), attempts: 1 }, // 3h old
    );

    await bootAndPoll();

    expect(calledPaths()).toEqual(['/api/purge']);
  });

  it('stops retrying once purge has failed 5 times, and logs it only once', async () => {
    stubWeeklyRecord(
      { status: 'succeeded', ranAt: new Date('2026-03-09T06:05:00Z'), attempts: 1 },
      { status: 'failed', ranAt: new Date('2026-03-16T06:05:00Z'), attempts: 5 },
    );
    const error = console.error as unknown as ReturnType<typeof vi.fn>;

    await bootAndPoll();
    expect(fetchMock).not.toHaveBeenCalled();
    const afterFirstPoll = error.mock.calls.length;
    expect(afterFirstPoll).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(error.mock.calls.length).toBe(afterFirstPoll);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a DB error evaluating purge is logged and skipped, without taking themes/digest down or leaking a rejection', async () => {
    const leaked: unknown[] = [];
    const priorListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason) => leaked.push(reason));

    try {
      // themes and digest resolve normally (both never-run, so both get
      // called); purge's own read rejects.
      cronRunRecordMock.mockImplementation(async (job: string) => {
        if (job === 'purge') throw new Error('connection terminated');
        return null;
      });
      const error = console.error as unknown as ReturnType<typeof vi.fn>;

      await bootAndPoll();

      expect(calledPaths()).toEqual(['/api/themes', '/api/digest']);
      expect(error.mock.calls.flat().join(' ')).toContain('connection terminated');

      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(leaked).toEqual([]);
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const listener of priorListeners) {
        process.on('unhandledRejection', listener as (reason: unknown) => void);
      }
    }
  });
});

describe('register — scheduler-state (read by /api/admin/status)', () => {
  it('reports enabled with a clean first poll', async () => {
    await bootAndPoll();

    expect(getSchedulerState()).toMatchObject({
      enabled: true,
      startedAt: MONDAY_0800.toISOString(),
      lastPollAt: new Date(MONDAY_0800.getTime() + FIRST_POLL_MS).toISOString(),
      lastPollError: null,
    });
  });

  it('surfaces a per-job failure as lastPollError without stopping the poll', async () => {
    cronRunRecordMock.mockImplementation(async (job: string) => {
      if (job === 'themes') throw new Error('connection terminated');
      return PURGE_INERT;
    });

    await bootAndPoll();

    expect(getSchedulerState().lastPollError).toContain('connection terminated');
    expect(getSchedulerState().lastPollAt).not.toBeNull();
  });

  it('surfaces a cron route answering non-2xx, which the poll loop otherwise only logs', async () => {
    // The failure mode that matters most: the route is unreachable or broken
    // on every tick (a 404 after a bad deploy, say). No cron_runs row is ever
    // written, so the pipeline table alone looks like "about to run".
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => 'nope' });

    await bootAndPoll();

    expect(getSchedulerState().lastPollError).toBe('/api/digest returned 404');
  });

  it('surfaces a cron route call that throws (timeout, connection refused)', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    await bootAndPoll();

    expect(getSchedulerState().lastPollError).toBe('fetch failed');
  });

  it('stays disabled when E2E_DISABLE_SCHEDULER=1', async () => {
    vi.stubEnv('E2E_DISABLE_SCHEDULER', '1');

    await bootAndPoll();

    expect(getSchedulerState().enabled).toBe(false);
  });

  it('stays disabled outside the nodejs runtime and when env validation fails', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await bootAndPoll();
    expect(getSchedulerState().enabled).toBe(false);

    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    validateEnvMock.mockImplementation(() => {
      throw new Error('Missing required environment variables');
    });
    await expect(register()).rejects.toThrow('Missing required environment variables');
    expect(getSchedulerState().enabled).toBe(false);
  });

  it('clears a stale error on the next clean poll', async () => {
    cronRunRecordMock.mockImplementationOnce(async () => {
      throw new Error('transient');
    });

    await bootAndPoll();
    expect(getSchedulerState().lastPollError).toContain('transient');
    const firstPollAt = getSchedulerState().lastPollAt;

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(getSchedulerState().lastPollError).toBeNull();
    expect(getSchedulerState().lastPollAt).not.toBe(firstPollAt);
  });
});

describe('register — error reporting (src/lib/report-error.ts)', () => {
  /** The fingerprint summaries reportError holds for one context. */
  function reported(context: string) {
    return getErrorReportSnapshot().fingerprints.filter((f) => f.context === context);
  }

  /** Node passes `origin` to monitor listeners; @types/node's emit() overload omits it. */
  function emitUncaughtMonitor(err: Error) {
    const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
    emit('uncaughtExceptionMonitor', err, 'uncaughtException');
  }

  it('hooks process-level failures into reportError on boot', async () => {
    await register();

    emitUncaughtMonitor(new Error('kaboom'));

    expect(reported('process.uncaughtException')).toEqual([expect.objectContaining({ message: 'kaboom', count: 1 })]);
  });

  it('hooks them even when E2E_DISABLE_SCHEDULER=1 — they have nothing to do with the scheduler', async () => {
    vi.stubEnv('E2E_DISABLE_SCHEDULER', '1');
    await register();

    emitUncaughtMonitor(new Error('kaboom'));

    expect(reported('process.uncaughtException')).toHaveLength(1);
  });

  it('does not hook anything outside the nodejs runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const before = process.listenerCount('uncaughtExceptionMonitor');

    await register();

    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before);
  });

  it('reports a cron route answering non-2xx with its path and the body that says why', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => '{"error":"connection terminated","weekOf":"2026-03-09"}',
    });

    await bootAndPoll();

    const [themes] = reported('cron.scheduler').filter((f) => f.message.startsWith('/api/themes'));
    expect(themes.message).toBe('/api/themes returned 500: {"error":"connection terminated","weekOf":"2026-03-09"}');
    expect(getErrorReportSnapshot().recent.find((r) => r.message.startsWith('/api/themes'))?.meta).toEqual({
      path: '/api/themes',
      weekOf: WEEK_OF,
    });
    // The scheduler-state message the status endpoint shows stays the short form.
    expect(getSchedulerState().lastPollError).toBe('/api/digest returned 500');
  });

  it('hands reportError the whole body, so an address near the old 500-char cut is redacted, not halved', async () => {
    // '{"error":"' + 480 x's + ' ' puts 'jane.doe' at 491 and its '@' at 499:
    // cut at 500 before redaction, the local part no longer looked like an
    // address and went out verbatim.
    const body = JSON.stringify({ error: `${'x'.repeat(480)} jane.doe@customer.example could not be saved` });
    expect(body.indexOf('jane.doe@')).toBe(491);
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => body });
    const errorLog = vi.mocked(console.error);

    await bootAndPoll();

    const [themes] = reported('cron.scheduler').filter((f) => f.message.startsWith('/api/themes'));
    expect(themes.message).toContain('[redacted email] could not be saved');
    expect(JSON.stringify(getErrorReportSnapshot())).not.toContain('jane');
    const logged = errorLog.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).not.toContain('jane');
  });

  it('bounds a huge non-2xx body in the report and leaves the synthetic stack out of it', async () => {
    // A proxy's HTML error page can be any size. The stack of the Error the
    // scheduler builds would only repeat the body and point at its own fetch
    // wrapper; the path in meta already says which route failed.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => `<html>${'bad gateway '.repeat(10_000)}</html>`,
    });
    const errorLog = vi.mocked(console.error);

    await bootAndPoll();

    const [themes] = reported('cron.scheduler').filter((f) => f.message.startsWith('/api/themes'));
    expect(themes.message.length).toBeLessThanOrEqual(1000 + '…[truncated]'.length);
    expect(themes.message).toMatch(/…\[truncated\]$/);
    const line = errorLog.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { message: string; stack: string | null })
      .find((l) => l.message.startsWith('[cron.scheduler] /api/themes returned 502'));
    expect(line?.stack).toBeNull();
  });

  it('reports a cron route call that throws (timeout, connection refused)', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    await bootAndPoll();

    expect(reported('cron.scheduler')).toEqual([expect.objectContaining({ message: 'fetch failed', count: 2 })]);
  });

  it('reports a cron_runs read failure with the job it was evaluating', async () => {
    cronRunRecordMock.mockImplementation(async (job: string) => {
      if (job === 'themes') throw new Error('connection terminated');
      return PURGE_INERT;
    });

    await bootAndPoll();

    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'cron.scheduler', message: 'connection terminated', meta: { job: 'themes' } }),
    ]);
  });

  it('reports an exhausted week once per boot, not on every poll', async () => {
    stubWeeklyRecord({ status: 'failed', ranAt: new Date('2026-03-16T06:05:00Z'), attempts: 5 });

    await bootAndPoll();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(getErrorReportSnapshot().recent.map((r) => [r.message, r.meta])).toEqual([
      [`digest for week ${WEEK_OF} has failed 5 times — giving up until it's manually retried.`, { job: 'digest', weekOf: WEEK_OF }],
      [`themes for week ${WEEK_OF} has failed 5 times — giving up until it's manually retried.`, { job: 'themes', weekOf: WEEK_OF }],
    ]);
  });

  it('reports nothing on a clean poll', async () => {
    await bootAndPoll();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});
