import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSchedulerState,
  markPoll,
  markSchedulerStarted,
  resetSchedulerState,
} from '../scheduler-state';

beforeEach(() => {
  resetSchedulerState();
});

describe('scheduler-state', () => {
  it('starts disabled with nothing recorded', () => {
    expect(getSchedulerState()).toEqual({
      enabled: false,
      startedAt: null,
      lastPollAt: null,
      lastPollError: null,
    });
  });

  it('records the start instant and flips enabled', () => {
    markSchedulerStarted(new Date('2026-03-16T08:00:00Z'));

    expect(getSchedulerState()).toMatchObject({
      enabled: true,
      startedAt: '2026-03-16T08:00:00.000Z',
    });
  });

  it('records a clean poll and clears any earlier error', () => {
    markPoll(new Error('db down'), new Date('2026-03-16T08:00:00Z'));
    markPoll(undefined, new Date('2026-03-16T08:10:00Z'));

    expect(getSchedulerState()).toMatchObject({
      lastPollAt: '2026-03-16T08:10:00.000Z',
      lastPollError: null,
    });
  });

  it('keeps the message of an Error and stringifies anything else', () => {
    markPoll(new Error('connection terminated'));
    expect(getSchedulerState().lastPollError).toBe('connection terminated');

    markPoll('plain string');
    expect(getSchedulerState().lastPollError).toBe('plain string');
  });

  it('accepts a poll before any start and a re-start without losing the last poll', () => {
    markPoll(undefined, new Date('2026-03-16T08:00:00Z'));
    expect(getSchedulerState()).toMatchObject({ enabled: false, lastPollAt: '2026-03-16T08:00:00.000Z' });

    markSchedulerStarted(new Date('2026-03-16T08:01:00Z'));
    markSchedulerStarted(new Date('2026-03-16T08:02:00Z'));
    expect(getSchedulerState()).toMatchObject({
      startedAt: '2026-03-16T08:02:00.000Z',
      lastPollAt: '2026-03-16T08:00:00.000Z',
    });
  });

  it('hands out a copy, so a caller cannot mutate the live record', () => {
    markSchedulerStarted();
    const snapshot = getSchedulerState();
    snapshot.enabled = false;

    expect(getSchedulerState().enabled).toBe(true);
  });

  it('survives a module re-import (the globalThis guarantee next dev relies on)', async () => {
    markSchedulerStarted(new Date('2026-03-16T08:00:00Z'));

    vi.resetModules();
    const fresh = await import('../scheduler-state');

    expect(fresh.getSchedulerState()).toMatchObject({
      enabled: true,
      startedAt: '2026-03-16T08:00:00.000Z',
    });
  });
});
