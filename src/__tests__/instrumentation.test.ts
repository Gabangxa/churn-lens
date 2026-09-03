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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY_0800);

  validateEnvMock.mockReset();
  validateEnvMock.mockImplementation(() => {});
  cronRunRecordMock.mockReset();
  cronRunRecordMock.mockResolvedValue(null);

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
    cronRunRecordMock.mockResolvedValue(null);
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
    expect(cronRunRecordMock).not.toHaveBeenCalled();
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
    cronRunRecordMock.mockResolvedValue({
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
    cronRunRecordMock.mockResolvedValue({
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
    cronRunRecordMock.mockResolvedValue({
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
