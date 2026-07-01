/**
 * Reporting-week math for the Monday crons.
 *
 * The theme + digest jobs run Monday ~06:00 UTC and must report on the week that
 * just *ended* — i.e. the 7 days from the previous Monday 00:00 up to (but not
 * including) this Monday 00:00. The old code used `surveyed_at >= thisMonday`,
 * which at 06:00 captured only ~6 hours of data instead of the full prior week.
 */
export interface ReportingWeek {
  /** Inclusive start: previous Monday 00:00 UTC. */
  weekStart: Date;
  /** Exclusive end: this Monday 00:00 UTC. */
  weekEnd: Date;
  /** `YYYY-MM-DD` of weekStart — the value stored in themes.week_of. */
  weekOfStr: string;
}

/**
 * @param now Reference time (defaults to current time). Injectable for tests.
 */
export function reportingWeek(now: Date = new Date()): ReportingWeek {
  // Floor `now` to midnight UTC.
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  // Step back to the most recent Monday 00:00 UTC (Mon=0 … Sun=6).
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const weekEnd = new Date(today);
  weekEnd.setUTCDate(weekEnd.getUTCDate() - daysSinceMonday);

  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);

  return {
    weekStart,
    weekEnd,
    weekOfStr: weekStart.toISOString().split('T')[0],
  };
}
