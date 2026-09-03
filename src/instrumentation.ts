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
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { validateEnv } = await import('./lib/env');
  validateEnv();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const cronSecret = process.env.CRON_SECRET;

  if (!appUrl || !cronSecret) {
    console.warn(
      '[cron] NEXT_PUBLIC_APP_URL or CRON_SECRET not set — scheduled jobs will not run.',
    );
    return;
  }

  const { reportingWeek } = await import('./lib/week');
  const { JOBS, isDue, cronRunRecord } = await import('./lib/cron');

  // A week stuck at 'failed' past this many attempts is treated as broken,
  // not transient — stop hammering it every 10 minutes and wait for a human.
  const MAX_ATTEMPTS = 5;
  // Must match (or exceed) the reclaim threshold in claimCronRun's SQL, or
  // this loop would call the endpoint for a run the claim itself refuses to
  // reclaim yet — a wasted request that always comes back "already_ran".
  const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;
  const POLL_INTERVAL_MS = 10 * 60 * 1000;
  const FIRST_POLL_DELAY_MS = 30 * 1000;

  // "Log once per boot per job" for the exhausted-attempts case: it's a
  // standing condition once a week is broken, not a new event on every poll,
  // so re-logging it every 10 minutes would just be noise after the first page.
  const exhaustedLogged = new Set<string>();

  async function callCronEndpoint(path: string) {
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
      const json = await res.json();
      console.log(`[cron] ${path} →`, json);
    } catch (err) {
      console.error(`[cron] ${path} failed:`, err);
    }
  }

  async function pollOnce() {
    const now = new Date();

    for (const job of JOBS) {
      if (!isDue(job, now)) continue;

      const { weekOfStr } = reportingWeek(now);
      const record = await cronRunRecord(job.job, weekOfStr);

      // Done. Never call again for this week.
      if (record?.status === 'succeeded') continue;

      if (record?.status === 'running') {
        const staleMs = now.getTime() - record.ranAt.getTime();
        // Plausibly still in flight (this process or another instance) —
        // don't pile on a second concurrent call.
        if (staleMs < STALE_RUNNING_MS) continue;
        // Otherwise stale: the process that claimed it is presumed dead.
        // Fall through — the endpoint's own claim will reclaim the row.
      }

      if (record?.status === 'failed' && record.attempts >= MAX_ATTEMPTS) {
        const key = `${job.job}:${weekOfStr}`;
        if (!exhaustedLogged.has(key)) {
          exhaustedLogged.add(key);
          console.error(
            `[cron] ${job.job} for week ${weekOfStr} has failed ${record.attempts} times — giving up until it's manually retried.`,
          );
        }
        continue;
      }

      // status is null (never run), 'failed' (under the attempts cap), or a
      // stale 'running' — worth asking the endpoint to try/retry.
      await callCronEndpoint(job.path);
    }
  }

  // Give the app a moment to finish booting (DB pool, etc.) before the first
  // poll, then settle into a steady 10-minute cadence. unref() on both timers
  // so this loop never keeps the process alive on shutdown.
  const firstPoll = setTimeout(() => {
    void pollOnce();
    const interval = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    interval.unref();
  }, FIRST_POLL_DELAY_MS);
  firstPoll.unref();

  console.log(
    '[cron] Scheduler registered — polling every 10 min for themes (due Mon 06:00 UTC) ' +
      'and digest (due Mon 07:00 UTC), with catch-up and retry via cron_runs.',
  );
}
