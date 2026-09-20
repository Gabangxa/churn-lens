/**
 * In-process view of the cron scheduler (src/instrumentation.ts), read by
 * GET /api/admin/status so a founder can see "is the poll loop alive, when did
 * it last tick, did that tick hit an error" without grepping logs.
 *
 * Kept dependency-free on purpose: instrumentation.ts is also compiled for the
 * edge runtime, where anything reaching `pg` fails the build.
 *
 * State lives on globalThis rather than in a module-level variable because
 * under `next dev` the instrumentation hook and route handlers are separate
 * webpack compilations with their own module caches — a plain module singleton
 * would give the route a fresh, never-marked copy and it would always report
 * the scheduler as disabled. In the production build both share one runtime
 * and either approach works; globalThis works in both.
 */
export interface SchedulerState {
  /** markSchedulerStarted() ran in this process (false on edge, E2E, or failed boot). */
  enabled: boolean;
  /** ISO time the scheduler registered, or null. */
  startedAt: string | null;
  /** ISO time the most recent poll finished, or null if none has yet. */
  lastPollAt: string | null;
  /** Message of the last error seen during that poll, or null if it was clean. */
  lastPollError: string | null;
}

const SLOT = Symbol.for('churnlens.schedulerState');

type GlobalWithSlot = typeof globalThis & { [SLOT]?: SchedulerState };

function freshState(): SchedulerState {
  return { enabled: false, startedAt: null, lastPollAt: null, lastPollError: null };
}

function slot(): SchedulerState {
  const g = globalThis as GlobalWithSlot;
  if (!g[SLOT]) g[SLOT] = freshState();
  return g[SLOT];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function markSchedulerStarted(now: Date = new Date()): void {
  const state = slot();
  state.enabled = true;
  state.startedAt = now.toISOString();
}

/** Record the end of a poll; pass the error (if any) that poll encountered. */
export function markPoll(error?: unknown, now: Date = new Date()): void {
  const state = slot();
  state.lastPollAt = now.toISOString();
  state.lastPollError = error == null ? null : errorMessage(error);
}

/** A copy — callers must not be able to mutate the live record. */
export function getSchedulerState(): SchedulerState {
  return { ...slot() };
}

/** Test-only: wipe the shared slot so one test's boot does not leak into the next. */
export function resetSchedulerState(): void {
  (globalThis as GlobalWithSlot)[SLOT] = freshState();
}
