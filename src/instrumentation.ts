/**
 * Next.js Instrumentation Hook
 *
 * Runs once when the server process starts. Registers a lightweight
 * internal scheduler so no external cron service or npm scheduler
 * package is required.
 *
 * Schedules (all UTC), each due for the whole week that follows it:
 *   - Monday 06:00 — /api/themes  (AI theme clustering)
 *   - Monday 07:00 — /api/digest  (weekly founder email)
 *
 * This polls every 10 minutes rather than scheduling a one-shot timer for
 * the exact instant a job is due. A one-shot timer computed at boot silently
 * skips the week entirely if a redeploy or crash spans Monday morning — the
 * timer that would have fired never gets created. Polling means any boot (or
 * any 10-minute tick) within the week can notice the job never ran and catch
 * it up. `cron_runs` (src/lib/cron.ts) is still the source of truth for
 * whether a week is done, failed, or crashed mid-run — this loop only
 * decides when it's worth asking the endpoint to check.
 *
 * NOTE (intentional, not a bug): a week that's still in progress when the
 * *next* reporting week rolls over (the following Monday) is abandoned —
 * dueAt/isDue only ever track "the current reporting week", so a poll after
 * rollover stops asking about the old week and starts asking about the new
 * one. Handling that overlap is a follow-up, not this round.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { validateEnv } = await import('./lib/env');
  validateEnv();

  const { reportingWeek } = await import('./lib/week');
  const { JOBS, isDue, cronRunRecord, decidePollAction, MAX_ATTEMPTS, STALE_RUNNING_MS } =
    await import('./lib/cron');

  // validateEnv() above throws if either is unset, so by the time we get here
  // in a real boot they are guaranteed present — the `!` just tells
  // TypeScript what validateEnv already enforced at runtime.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const cronSecret = process.env.CRON_SECRET!;

  const POLL_INTERVAL_MS = 10 * 60 * 1000;
  const FIRST_POLL_DELAY_MS = 30 * 1000;

  // "Log once per boot per (job, week)" for standing conditions — an
  // exhausted retry budget or a themes-not-ready deferral don't change from
  // one 10-minute poll to the next, so re-logging them every tick would just
  // be noise after the first one.
  const exhaustedLogged = new Set<string>();
  const deferredLogged = new Set<string>();

  async function callCronEndpoint(path: string, weekOfStr: string) {
    try {
      const res = await fetch(`${appUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cronSecret}` },
        // Themes calls OpenAI once per org, sequentially, inside the request —
        // give it real headroom instead of aborting mid-run on a slow week.
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (!res.ok) {
        console.error(`[cron] ${path} returned ${res.status}:`, await res.text());
        return;
      }
      const json: unknown = await res.json();

      // The digest route returns { deferred: 'themes_not_ready' } every poll
      // while it waits on themes — a real, expected, standing condition, not
      // worth a fresh log line every 10 minutes once we've said it once.
      if (json && typeof json === 'object' && (json as { deferred?: string }).deferred === 'themes_not_ready') {
        const key = `${path}:${weekOfStr}`;
        if (deferredLogged.has(key)) return;
        deferredLogged.add(key);
      }

      console.log(`[cron] ${path} →`, json);
    } catch (err) {
      console.error(`[cron] ${path} failed:`, err);
    }
  }

  async function pollOnce() {
    const now = new Date();
    // Intentional: `reportingWeek(now)` always resolves to the CURRENT
    // reporting week, so a week still in progress (retrying, or genuinely
    // never claimed) is abandoned the moment the next Monday rolls over —
    // this poll simply stops asking about it. See the module doc comment
    // above for why that's a deliberate scope cut for this round, not a bug.

    for (const job of JOBS) {
      // Each job's evaluation is independent: a DB blip (or anything else)
      // while checking one job must not skip evaluating the other in the
      // same poll, and must not escape as an unhandled rejection — both of
      // which happened when this loop had no try/catch at all.
      try {
        if (!isDue(job, now)) continue;

        const { weekOfStr } = reportingWeek(now);
        const record = await cronRunRecord(job.job, weekOfStr);
        const action = decidePollAction(record, now, {
          maxAttempts: MAX_ATTEMPTS,
          staleRunningMs: STALE_RUNNING_MS,
        });

        if (action === 'skip') continue;

        if (action === 'exhausted') {
          const key = `${job.job}:${weekOfStr}`;
          if (!exhaustedLogged.has(key)) {
            exhaustedLogged.add(key);
            console.error(
              `[cron] ${job.job} for week ${weekOfStr} has failed ${record?.attempts ?? MAX_ATTEMPTS} ` +
                `times — giving up until it's manually retried.`,
            );
          }
          continue;
        }

        // action === 'call': never run, a stale crashed 'running' row, or a
        // 'failed' row whose backoff window has elapsed.
        await callCronEndpoint(job.path, weekOfStr);
      } catch (err) {
        console.error(`[cron] evaluating ${job.job} failed:`, err);
      }
    }
  }

  // Give the app a moment to finish booting (DB pool, etc.) before the first
  // poll, then settle into a steady 10-minute cadence. unref() on both timers
  // so this loop never keeps the process alive on shutdown. `.catch()` on the
  // void call is the last line of defense — pollOnce already catches per-job,
  // but nothing should ever turn a poll tick into an unhandled rejection.
  const firstPoll = setTimeout(() => {
    void pollOnce().catch((err) => console.error('[cron] poll failed:', err));
    const interval = setInterval(() => {
      void pollOnce().catch((err) => console.error('[cron] poll failed:', err));
    }, POLL_INTERVAL_MS);
    interval.unref();
  }, FIRST_POLL_DELAY_MS);
  firstPoll.unref();

  console.log(
    '[cron] Scheduler registered — polling every 10 min for themes (due Mon 06:00 UTC) ' +
      'and digest (due Mon 07:00 UTC), with catch-up and retry via cron_runs.',
  );
}
