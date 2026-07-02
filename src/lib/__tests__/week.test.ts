import { describe, it, expect } from 'vitest';
import { reportingWeek } from '../week';

describe('reportingWeek', () => {
  it('returns the just-ended week [prev Monday, this Monday) when run on a Monday', () => {
    // Monday 2026-03-16 06:00 UTC — the cron's normal fire time.
    const { weekStart, weekEnd, weekOfStr } = reportingWeek(new Date('2026-03-16T06:00:00Z'));
    expect(weekStart.toISOString()).toBe('2026-03-09T00:00:00.000Z'); // prev Monday
    expect(weekEnd.toISOString()).toBe('2026-03-16T00:00:00.000Z'); // this Monday
    expect(weekOfStr).toBe('2026-03-09');
  });

  it('spans exactly 7 days', () => {
    const { weekStart, weekEnd } = reportingWeek(new Date('2026-03-16T06:00:00Z'));
    const days = (weekEnd.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(7);
  });

  it('floors to the most recent Monday when run mid-week', () => {
    // Thursday 2026-03-19 → most recent Monday is 2026-03-16.
    const { weekStart, weekEnd } = reportingWeek(new Date('2026-03-19T12:00:00Z'));
    expect(weekEnd.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(weekStart.toISOString()).toBe('2026-03-09T00:00:00.000Z');
  });

  it('handles Sunday (day 0) without rolling into the wrong week', () => {
    // Sunday 2026-03-15 → most recent Monday is still 2026-03-09.
    const { weekEnd } = reportingWeek(new Date('2026-03-15T23:59:00Z'));
    expect(weekEnd.toISOString()).toBe('2026-03-09T00:00:00.000Z');
  });
});
