/**
 * Next.js Instrumentation Hook
 *
 * Runs once when the server process starts. Registers a lightweight
 * internal scheduler so no external cron service or npm scheduler
 * package is required.
 *
 * Schedules (all UTC):
 *   - Monday 06:00 — /api/themes  (AI theme clustering)
 *   - Monday 07:00 — /api/digest  (weekly founder email)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const cronSecret = process.env.CRON_SECRET;

  if (!appUrl || !cronSecret) {
    console.warn(
      '[cron] NEXT_PUBLIC_APP_URL or CRON_SECRET not set — scheduled jobs will not run.',
    );
    return;
  }

  async function callCronEndpoint(path: string) {
    try {
      const res = await fetch(`${appUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cronSecret}` },
      });
      const json = await res.json();
      console.log(`[cron] ${path} →`, json);
    } catch (err) {
      console.error(`[cron] ${path} failed:`, err);
    }
  }

  /**
   * Returns milliseconds until the next occurrence of a given
   * day-of-week + hour (UTC). day: 0=Sun, 1=Mon … 6=Sat.
   */
  function msUntilNext(targetDay: number, targetHourUtc: number): number {
    const now = new Date();
    const next = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        targetHourUtc,
        0,
        0,
        0,
      ),
    );
    // Advance day-of-week to the target
    const daysAhead = (targetDay - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + daysAhead);
    // If we've already passed this moment today, jump a full week ahead
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 7);
    }
    return next.getTime() - now.getTime();
  }

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function scheduleWeekly(targetDay: number, targetHourUtc: number, job: () => void) {
    const delay = msUntilNext(targetDay, targetHourUtc);
    const label = `day=${targetDay} hour=${targetHourUtc}UTC`;
    console.log(`[cron] Next run for ${label} in ${Math.round(delay / 60000)} min`);

    setTimeout(function tick() {
      job();
      setTimeout(tick, ONE_WEEK_MS);
    }, delay);
  }

  // Monday (1) at 06:00 UTC — cluster AI themes
  scheduleWeekly(1, 6, () => callCronEndpoint('/api/themes'));

  // Monday (1) at 07:00 UTC — send weekly digest emails
  scheduleWeekly(1, 7, () => callCronEndpoint('/api/digest'));

  console.log('[cron] Scheduler registered — themes @ Mon 06:00 UTC, digest @ Mon 07:00 UTC');
}
