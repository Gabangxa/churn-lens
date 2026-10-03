import { getResend, FROM_EMAIL } from '@/lib/resend';

/**
 * In-house error alerting: one call, `reportError(context, err, meta)`, for
 * every catch site where something genuinely failed (not a user's bad input).
 *
 * Chosen over Sentry on purpose: no new dependency and no new sub-processor.
 * The alert goes out through Resend, which is already a disclosed
 * sub-processor, to the founder's own ALERT_EMAIL.
 *
 * Each call:
 *   1. writes ONE structured JSON line to stderr (Railway parses `level` and
 *      `message` out of JSON lines; the rest become searchable attributes);
 *   2. records the error in an in-process ring buffer with per-fingerprint
 *      counts, read by GET /api/admin/status and so by `npm run monitor`;
 *   3. emails ALERT_EMAIL — the first occurrence of a fingerprint at once; a
 *      fingerprint that keeps recurring backs off (ALERT_BACKOFF_MS: 1h, then
 *      4h, then daily), each alert carrying how many were suppressed; never
 *      more than MAX_ALERTS_PER_HOUR or MAX_ALERTS_PER_DAY in total; sends
 *      spaced ALERT_SEND_SPACING_MS apart.
 *
 * PII: callers pass ids only in `meta`, never names, emails or survey text.
 * Error messages and stacks are not under the caller's control (a Postgres
 * unique-violation names the duplicate key; a Resend error can quote the `to`
 * address), so anything email-shaped is redacted from the message, the stack
 * and meta before it is logged, buffered or emailed.
 *
 * reportError never throws. It runs inside catch blocks and inside the
 * process-level uncaughtException monitor, where a throw of its own would
 * crash the process outright.
 *
 * State lives on globalThis for the same reason as src/lib/scheduler-state.ts:
 * under `next dev` the instrumentation hook and the route handlers are
 * separate webpack compilations with separate module caches, and the throttle
 * only works if both see the same counts. It is per process: a restart or
 * redeploy empties the buffer and resets the throttle.
 */

/** Ids only — see the PII note above. Values are redacted anyway, as a backstop. */
export type ErrorMeta = Record<string, string | number | boolean | null | undefined>;

export interface ReportedError {
  /** ISO time reportError was called. */
  at: string;
  context: string;
  name: string;
  /** Redacted and truncated. */
  message: string;
  fingerprint: string;
  meta: Record<string, string | number | boolean | null>;
}

export interface FingerprintSummary {
  fingerprint: string;
  context: string;
  name: string;
  /** The most recent example's message (ids in it vary; the fingerprint does not). */
  message: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * The occurrence the last DELIVERED alert email for this fingerprint was
   * about; null = none delivered yet. A failed send does not set it.
   */
  lastAlertAt: string | null;
  /** Occurrences not (yet) carried by a delivered alert: backoff, caps, failed sends. */
  suppressedSinceAlert: number;
}

export interface AlertBudget {
  maxPerHour: number;
  maxPerDay: number;
  /** Alert sends started or queued in the last hour / day, failed ones included. */
  attemptsLastHour: number;
  attemptsLastDay: number;
  /** Alerts waiting in the send queue for their ALERT_SEND_SPACING_MS slot. */
  queued: number;
}

export interface ErrorReportSnapshot {
  /** ALERT_EMAIL is set; false means errors are logged and buffered but never emailed. */
  alertingConfigured: boolean;
  /** Every reportError call since this process started, including ones evicted from `recent`. */
  totalReported: number;
  alertsSent: number;
  alertsFailed: number;
  /** Why the most recent failed alert send failed (redacted), or null. */
  lastAlertError: string | null;
  /** Newest first, at most RECENT_ERRORS_LIMIT. */
  recent: ReportedError[];
  /** Most recently seen first, at most MAX_FINGERPRINTS. */
  fingerprints: FingerprintSummary[];
  alertBudget: AlertBudget;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a fingerprint that keeps recurring waits before its next alert:
 * after the 1st delivered alert of an episode, after the 2nd, and after the
 * 3rd and every later one. A broken cron or a dead integration fails the same
 * way all day; hourly mail about it buries anything new in the inbox and
 * spends the shared Resend quota, while 1h → 4h → daily still says "still
 * broken" and each alert carries the suppressed count.
 */
export const ALERT_BACKOFF_MS = [HOUR_MS, 4 * HOUR_MS, DAY_MS] as const;

/**
 * A fingerprint not seen for this long starts a new episode: its next
 * occurrence alerts at once and the backoff starts over at the first step.
 * Never shorter than the longest backoff step, so a new episode is always due.
 */
export const QUIET_RESET_MS = DAY_MS;

/**
 * Hard ceiling on alert emails across ALL fingerprints per sliding hour. The
 * per-fingerprint backoff alone still lets an outage that fails a dozen
 * different code paths send a dozen emails at once — and alerts share the
 * Resend account (and its sending quota) with the survey emails that are the
 * product's whole job. Suppressed occurrences are still counted and ride
 * along on that fingerprint's next alert.
 */
export const MAX_ALERTS_PER_HOUR = 10;

/**
 * …and per sliding day. The hourly cap alone allows 240 a day: a slow trickle
 * of new fingerprints (or a recurring one per hour across many) would spend
 * the quota that login links and survey emails need. 24 is still one an hour
 * on average, far more than one person acts on.
 */
export const MAX_ALERTS_PER_DAY = 24;

/**
 * Minimum gap between two alert sends. Resend's default rate limit is 2
 * requests a second per account (shared with survey emails and login links);
 * a burst of new fingerprints sent at once had the extras rejected with 429.
 * One in-process queue releases them this far apart instead.
 */
export const ALERT_SEND_SPACING_MS = 600;

export const RECENT_ERRORS_LIMIT = 50;

/**
 * Bounds the per-fingerprint map. A message with an id the normaliser does not
 * recognise would otherwise mint a new fingerprint per occurrence and grow the
 * map forever. The least recently seen fingerprint is evicted, which also
 * forgets its backoff — it may alert again sooner than its next step, within
 * the hourly and daily caps. Acceptable: at this size an eviction already
 * means something is very noisy.
 */
const MAX_FINGERPRINTS = 100;

const MAX_MESSAGE_CHARS = 1000;
const MAX_STACK_CHARS = 4000;
const MAX_SUBJECT_MESSAGE_CHARS = 120;

/**
 * Email redaction works on runs: maximal stretches of characters an address
 * can contain. A run is redacted WHOLE when it holds a separator with
 * something before it and, somewhere after that, a dot followed by two
 * letters (the TLD). Deliberately broad: a false positive costs a redacted
 * token in a log line, a false negative leaks a churned customer's address
 * into logs and an inbox. Beyond plain ASCII that means:
 *   - any non-ASCII character other than whitespace, because internationalised
 *     addresses (jöhn@exämple.de, андрей@почта.рф, 用户@例子.广告) are real
 *     and Stripe and Resend pass them through. Broader than "letters": a
 *     non-ASCII quote or dash glued to an address goes with it, which is the
 *     cheap side of the trade above;
 *   - the separator as `@`, fullwidth `＠` (U+FF20), URL-encoded `%40` (an
 *     address that was a query parameter of a failed request) and
 *     double-encoded `%2540` (one that went through two encoders);
 *   - `%` anywhere, so a percent-encoded IDN (caf%C3%A9.example) stays one
 *     run, and the fullwidth and ideographic full stops browsers accept as dots.
 *
 * Why runs and not one address regex: with `%` and digits allowed on both
 * sides of a separator that is itself spelled with `%` and digits, a single
 * backtracking pattern goes cubic — 2000 chars of "%2540" took ~1.8 s, and
 * request input reaches these messages (Postgres quotes a rejected value).
 * Every pattern below is a single linear scan.
 *
 * No `u` flag and no `\p{…}` classes: tsconfig sets no `target`, so tsc
 * checks against ES5 and rejects the flag. Without it the patterns see UTF-16
 * code units, and "non-ASCII" covers both halves of a surrogate pair, so
 * astral-plane characters stay inside a run too.
 *
 * Kept off the TLD rule: version strings (pkg@1.2.3) and scoped package paths
 * in stacks (node_modules/@vitest/…), which have no letters after a dot.
 */
const EMAIL_CHAR_RUN = /(?:[A-Za-z0-9._%+@-]|[^\x00-\x7F\s])+/g;
const ADDRESS_SEPARATOR = /@|＠|%40|%2540/;
const DOT_THEN_TLD = /[.．。](?:[A-Za-z]|[^\x00-\x7F\s]){2}/;
/** One UTF-16 code unit of a run — used to drop a token a length cut split. */
const EMAIL_CHAR = /[A-Za-z0-9._%+@-]|[^\x00-\x7F\s]/;
const REDACTED_EMAIL = '[redacted email]';

const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface FingerprintState {
  fingerprint: string;
  context: string;
  name: string;
  message: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAlertAt: number | null;
  suppressedSinceAlert: number;
  /** Alerts delivered since this episode began (see QUIET_RESET_MS); picks the backoff step. */
  alertsThisEpisode: number;
  /** An alert for this fingerprint is queued or in flight: later occurrences wait, counted. */
  alertPending: boolean;
}

interface QueuedAlert {
  to: string;
  alert: AlertContent;
}

interface ProcessHandlers {
  onUncaughtMonitor: (err: unknown, origin: string) => void;
  /** null when nothing else was listening, so ours was deliberately not added. */
  onUnhandledRejection: ((reason: unknown) => void) | null;
}

interface ReportState {
  /** Oldest first; the snapshot reverses it. */
  recent: ReportedError[];
  /** Map iteration order doubles as recency: an entry is re-inserted on every hit. */
  byFingerprint: Map<string, FingerprintState>;
  totalReported: number;
  /** Decision times of alert sends inside the sliding day, oldest first; failed sends included. */
  alertAttemptTimes: number[];
  /** Alerts waiting for their send slot, oldest first. Bounded by the caps. */
  sendQueue: QueuedAlert[];
  /** When the queue last handed an alert to Resend; spacing is measured from it. */
  lastSendStartedAt: number | null;
  /** The pending timer that releases the next queued alert, if any. */
  sendTimer: ReturnType<typeof setTimeout> | null;
  alertsSent: number;
  alertsFailed: number;
  lastAlertError: string | null;
  warnedAlertsDisabled: boolean;
  /** Which cap last refused an alert; cleared by the next alert that gets through. */
  capWarned: { hour: boolean; day: boolean };
  processHandlers: ProcessHandlers | null;
}

const SLOT = Symbol.for('churnlens.errorReports');

type GlobalWithSlot = typeof globalThis & { [SLOT]?: ReportState };

function freshState(): ReportState {
  return {
    recent: [],
    byFingerprint: new Map(),
    totalReported: 0,
    alertAttemptTimes: [],
    sendQueue: [],
    lastSendStartedAt: null,
    sendTimer: null,
    alertsSent: 0,
    alertsFailed: 0,
    lastAlertError: null,
    warnedAlertsDisabled: false,
    capWarned: { hour: false, day: false },
    processHandlers: null,
  };
}

function slot(): ReportState {
  const g = globalThis as GlobalWithSlot;
  if (!g[SLOT]) g[SLOT] = freshState();
  return g[SLOT];
}

function redactEmails(text: string): string {
  return text.replace(EMAIL_CHAR_RUN, (run) => {
    // Searched from the second character: an address needs a local part.
    const separatorAt = run.slice(1).search(ADDRESS_SEPARATOR);
    if (separatorAt === -1) return run;
    return DOT_THEN_TLD.test(run.slice(separatorAt + 1)) ? REDACTED_EMAIL : run;
  });
}

/**
 * Redact, then truncate — in that order, so the final cut can never leave half
 * an address that no longer looks email-shaped.
 *
 * Input is bounded first because the regex's cost grows with length, and some
 * messages quote caller input verbatim (Postgres's "invalid input syntax for
 * type uuid" includes the raw value, at whatever length it arrived). That cut
 * CAN split an address, and since redaction may then shrink the text below
 * the final cut, the split token is dropped whole: every trailing character
 * an address could contain goes, so no partial address reaches the output.
 */
function scrub(text: string, maxChars: number): string {
  let bounded = text;
  const regexBudget = maxChars * 2;
  if (text.length > regexBudget) {
    let end = regexBudget;
    while (end > 0 && EMAIL_CHAR.test(text[end - 1])) end--;
    bounded = `${text.slice(0, end)}…[truncated]`;
  }
  const redacted = redactEmails(bounded);
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars)}…[truncated]`;
}

function scrubMeta(meta: ErrorMeta): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    safe[key] = typeof value === 'string' ? scrub(value, 200) : value;
  }
  return safe;
}

interface DescribedError {
  name: string;
  message: string;
  stack: string | null;
}

function describeError(err: unknown): DescribedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? null };
  }
  // The Resend SDK resolves with a plain `{ name, message }` object rather than
  // an Error; an Error from another realm fails instanceof but has the same shape.
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    const shaped = err as { name?: unknown; message: string; stack?: unknown };
    return {
      name: typeof shaped.name === 'string' ? shaped.name : 'Error',
      message: shaped.message,
      stack: typeof shaped.stack === 'string' ? shaped.stack : null,
    };
  }
  let message: string;
  try {
    message = String(err);
  } catch {
    // A thrown value whose toString throws. Still worth recording that
    // *something* was thrown here rather than losing the report entirely.
    message = '[unprintable thrown value]';
  }
  return { name: 'NonError', message, stack: null };
}

/**
 * FNV-1a, 32-bit, as 8 hex chars. A grouping key, not a security boundary:
 * with at most MAX_FINGERPRINTS live keys a collision is around one in a
 * million, and its cost is two errors sharing a count. Pure JS on purpose —
 * node's `crypto` breaks the Edge compile of instrumentation.ts, which
 * reaches this module ("Module not found: Can't resolve 'crypto'").
 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A quoted value: "…", `…`, or '…' where the opening quote does not follow a
 * letter or digit (ASCII, or any non-ASCII non-space, as in the redaction
 * patterns above) — so the apostrophes in "can't reach the server's" are
 * prose, not a literal. Postgres, Stripe and JSON.parse all quote the
 * offending value.
 */
const QUOTED_LITERAL = /"[^"\n]*"|`[^`\n]*`|(?<![A-Za-z0-9]|[^\x00-\x7F\s])'[^'\n]*'/g;

/**
 * Prefixed ids: cus_…, sub_…, req_…, evt_…, whsec_…. Only replaced when the
 * part after the underscore has a digit or a capital (see isPrefixedId) —
 * random ids almost always do, and snake_case table and column names
 * (survey_responses, login_tokens) never do and must stay distinct.
 */
const PREFIXED_ID = /\b[a-z]{2,8}_[A-Za-z0-9]{6,}\b/g;

/**
 * 8+ letters and digits with at least one of each: hex and base62 ids. Both
 * are required so ordinary long words ("terminated", "connection") survive;
 * all-digit runs are the digit rule's job.
 */
const ALNUM_ID = /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{8,}\b/g;

function isPrefixedId(token: string): boolean {
  return /[A-Z0-9]/.test(token.slice(token.indexOf('_') + 1));
}

/**
 * Groups occurrences that differ only in ids and quoted values (emails are
 * already redacted by the time this runs). Every distinct fingerprint costs
 * an immediate alert and a slot in the MAX_FINGERPRINTS map, so an id the
 * normaliser misses turns a recurring failure into an alert per occurrence
 * that also evicts the entries that matter. Order matters: quoted values and
 * whole ids go before the digit rule would break them up. The stack is left
 * out so a redeploy that shifts line numbers does not split a group.
 */
function fingerprintOf(context: string, name: string, message: string): string {
  const normalised = message
    .replace(QUOTED_LITERAL, '<q>')
    .replace(UUID_SHAPED, '<id>')
    .replace(PREFIXED_ID, (token) => (isPrefixedId(token) ? '<id>' : token))
    .replace(ALNUM_ID, '<id>')
    .replace(/\d+/g, '<n>');
  return fnv1a32(`${context}\n${name}\n${normalised}`);
}

/** RAILWAY_ENVIRONMENT_NAME, else NODE_ENV — `||` because an empty value names nothing. */
function currentEnvironment(): string {
  return process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'unknown';
}

function alertRecipient(): string | null {
  const to = process.env.ALERT_EMAIL?.trim();
  return to ? to : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * One JSON line. `message` carries a `[context]` prefix, the codebase's
 * existing "[cron] …" convention, because Railway's log view and the
 * monitor's log tail show only `message`: a bare "connection terminated"
 * says nothing about where. It is also what the monitor's "cron only" filter
 * matches on. `context` stays a field of its own for filtering in Railway.
 */
function logLine(
  level: 'error' | 'warn',
  context: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, context, message: `[${context}] ${message}`, ...extra });
  if (level === 'warn') console.warn(line);
  else console.error(line);
}

function recordOccurrence(state: ReportState, now: number, report: ReportedError): FingerprintState {
  state.totalReported++;
  state.recent.push(report);
  if (state.recent.length > RECENT_ERRORS_LIMIT) state.recent.shift();

  let entry = state.byFingerprint.get(report.fingerprint);
  if (entry) {
    // Re-inserted below so the Map's iteration order stays least- to most-recent.
    state.byFingerprint.delete(report.fingerprint);
    // Back after a quiet day: a new episode, not more of the old one. Checked
    // against the PREVIOUS sighting, before lastSeenAt moves to now.
    if (now - entry.lastSeenAt >= QUIET_RESET_MS) entry.alertsThisEpisode = 0;
  } else {
    entry = {
      fingerprint: report.fingerprint,
      context: report.context,
      name: report.name,
      message: report.message,
      count: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      lastAlertAt: null,
      suppressedSinceAlert: 0,
      alertsThisEpisode: 0,
      alertPending: false,
    };
  }
  entry.count++;
  entry.lastSeenAt = now;
  entry.message = report.message;
  state.byFingerprint.set(report.fingerprint, entry);

  if (state.byFingerprint.size > MAX_FINGERPRINTS) {
    const leastRecent = state.byFingerprint.keys().next().value;
    if (leastRecent !== undefined) state.byFingerprint.delete(leastRecent);
  }
  return entry;
}

interface AlertContent {
  context: string;
  name: string;
  message: string;
  stack: string | null;
  fingerprint: string;
  environment: string;
  meta: Record<string, string | number | boolean | null>;
  now: number;
  entry: FingerprintState;
  suppressed: number;
  previousAlertAt: number | null;
  /** When this fingerprint may alert again if this alert is delivered (backoff only; caps aside). */
  nextDueAt: number;
}

function alertSubject(alert: AlertContent): string {
  const firstLine = alert.message.split('\n')[0];
  const short =
    firstLine.length > MAX_SUBJECT_MESSAGE_CHARS ? `${firstLine.slice(0, MAX_SUBJECT_MESSAGE_CHARS)}…` : firstLine;
  return `[ChurnLens ${alert.environment}] ${alert.context}: ${short}`;
}

function alertText(alert: AlertContent): string {
  const lines = [
    `ChurnLens caught an error in ${alert.environment}.`,
    '',
    `Context:      ${alert.context}`,
    `Error:        ${alert.name}: ${alert.message}`,
    `Fingerprint:  ${alert.fingerprint}`,
    `When:         ${iso(alert.now)}`,
    `Occurrences:  ${alert.entry.count} in this process since ${iso(alert.entry.firstSeenAt)}`,
  ];
  if (alert.suppressed > 0) {
    const since = alert.previousAlertAt === null ? 'this fingerprint was first seen' : `the last alert at ${iso(alert.previousAlertAt)}`;
    lines.push('', `${alert.suppressed} more occurrence(s) were suppressed since ${since}.`);
  }
  lines.push(
    '',
    `Next alert for this fingerprint: no sooner than ${iso(alert.nextDueAt)}, and only if it recurs.`,
  );
  const metaEntries = Object.entries(alert.meta);
  if (metaEntries.length > 0) {
    lines.push('', 'Ids:', ...metaEntries.map(([key, value]) => `  ${key}: ${String(value)}`));
  }
  if (alert.stack) lines.push('', 'Stack:', alert.stack);
  lines.push(
    '',
    '---',
    'A recurring fingerprint alerts after 1 hour, then 4 hours, then daily, starting over after a quiet day;',
    `at most ${MAX_ALERTS_PER_HOUR} alerts an hour and ${MAX_ALERTS_PER_DAY} a day overall.`,
    'Every occurrence is still logged; recent ones are listed by `railway run npm run monitor`.',
    'Anything email-shaped has been redacted from this message.',
  );
  return lines.join('\n');
}

function recordAlertFailure(state: ReportState, reason: string, fingerprint: string): void {
  // Logged directly, NEVER via reportError: a failing send that reported
  // itself would alert about the alert, which fails, which alerts…
  const safeReason = scrub(reason, 500);
  state.alertsFailed++;
  state.lastAlertError = safeReason;
  logLine('error', 'report-error.alert', `alert email send failed: ${safeReason}`, { fingerprint });
}

/**
 * Delivered: the backoff clock starts at the occurrence the alert was about.
 * Failed: nothing is stamped, so the fingerprint's next occurrence tries
 * again (stamping before the send muted a burst's 429-rejected alerts for an
 * hour); the hourly and daily caps, which count failed attempts too, are what
 * stop a Resend outage turning into a request storm. The occurrence and the
 * backlog this alert carried go back on the suppressed count, so the retry
 * still reports them.
 */
async function sendAlert(state: ReportState, to: string, alert: AlertContent): Promise<void> {
  const { entry } = alert;
  let failure: string | null = null;
  try {
    // Resend resolves with `{ data: null, error }` on failure rather than
    // throwing — both shapes have to be treated as a failed send.
    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to,
      subject: alertSubject(alert),
      text: alertText(alert),
    });
    if (error) failure = `${error.name}: ${error.message}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : 'non-Error thrown by the Resend client';
  }

  entry.alertPending = false;
  if (failure !== null) {
    entry.suppressedSinceAlert += alert.suppressed + 1;
    recordAlertFailure(state, failure, alert.fingerprint);
    return;
  }
  state.alertsSent++;
  entry.lastAlertAt = alert.now;
  entry.alertsThisEpisode++;
}

function warnAlertsDisabledOnce(state: ReportState): void {
  if (state.warnedAlertsDisabled) return;
  state.warnedAlertsDisabled = true;
  logLine(
    'warn',
    'report-error',
    'ALERT_EMAIL is not set — error alert emails are disabled. Errors are still logged and listed in GET /api/admin/status.',
  );
}

/** How long to wait after the `delivered`-th alert of an episode (1-based). */
function backoffAfter(delivered: number): number {
  return ALERT_BACKOFF_MS[Math.min(delivered, ALERT_BACKOFF_MS.length) - 1];
}

function dueForFingerprint(entry: FingerprintState, now: number): boolean {
  if (entry.alertsThisEpisode === 0 || entry.lastAlertAt === null) return true;
  return now - entry.lastAlertAt >= backoffAfter(entry.alertsThisEpisode);
}

/** Drops attempts older than a day and says which cap, if any, is spent. */
function spentCap(state: ReportState, now: number): 'hour' | 'day' | null {
  state.alertAttemptTimes = state.alertAttemptTimes.filter((at) => now - at < DAY_MS);
  if (state.alertAttemptTimes.length >= MAX_ALERTS_PER_DAY) return 'day';
  const lastHour = state.alertAttemptTimes.filter((at) => now - at < HOUR_MS).length;
  return lastHour >= MAX_ALERTS_PER_HOUR ? 'hour' : null;
}

/** Once per stretch of refusals: the flag clears when an alert next gets through. */
function warnCapSpent(state: ReportState, cap: 'hour' | 'day', fingerprint: string): void {
  if (state.capWarned[cap]) return;
  state.capWarned[cap] = true;
  const limit = cap === 'hour' ? `${MAX_ALERTS_PER_HOUR} emails per hour` : `${MAX_ALERTS_PER_DAY} emails per day`;
  logLine(
    'warn',
    'report-error',
    `alert budget of ${limit} is spent; further alerts are counted, not sent, until it frees up`,
    { fingerprint },
  );
}

/**
 * Hands queued alerts to Resend at most one per ALERT_SEND_SPACING_MS. The
 * first alert after a quiet spell goes out synchronously (no timer), so a
 * lone failure is mailed at once. The queue never grows past the caps: an
 * alert is admitted (and counted) before it is queued.
 */
function pumpSendQueue(state: ReportState): void {
  if (state.sendTimer !== null || state.sendQueue.length === 0) return;

  const now = Date.now();
  if (state.lastSendStartedAt !== null) {
    // Clamped so a clock stepped backwards cannot stall the queue.
    const wait = Math.min(state.lastSendStartedAt + ALERT_SEND_SPACING_MS - now, ALERT_SEND_SPACING_MS);
    if (wait > 0) {
      state.sendTimer = setTimeout(() => {
        state.sendTimer = null;
        try {
          pumpSendQueue(state);
        } catch (internal) {
          // Outside reportError's own try: a throw here would be an uncaught
          // exception, which the process monitor reports, which queues…
          const reason = internal instanceof Error ? scrub(internal.message, 500) : 'non-Error thrown';
          logLine('error', 'report-error', `alert send queue failed: ${reason}`);
        }
      }, wait);
      return;
    }
  }

  const next = state.sendQueue.shift();
  if (!next) return;
  state.lastSendStartedAt = now;
  // Fire-and-forget: callers are request handlers and the cron loop, which
  // must not wait on (or fail because of) an email to the founder. sendAlert
  // catches everything itself, so this promise never rejects.
  void sendAlert(state, next.to, next.alert);
  pumpSendQueue(state);
}

/**
 * Decides, synchronously, whether this occurrence is emailed. Synchronous on
 * purpose: the bookkeeping (alertPending, the caps) is updated before the
 * send is even queued, so two reports in the same tick cannot both decide
 * they are "first". An occurrence that is not emailed is counted on its
 * fingerprint and rides along on the next alert that is.
 */
function maybeAlert(
  state: ReportState,
  alert: Omit<AlertContent, 'suppressed' | 'previousAlertAt' | 'nextDueAt'>,
): void {
  const to = alertRecipient();
  if (!to) {
    warnAlertsDisabledOnce(state);
    return;
  }

  const { entry, now } = alert;
  if (entry.alertPending || !dueForFingerprint(entry, now)) {
    entry.suppressedSinceAlert++;
    return;
  }

  const cap = spentCap(state, now);
  if (cap !== null) {
    entry.suppressedSinceAlert++;
    warnCapSpent(state, cap, alert.fingerprint);
    return;
  }
  state.capWarned = { hour: false, day: false };

  const suppressed = entry.suppressedSinceAlert;
  entry.suppressedSinceAlert = 0;
  entry.alertPending = true;
  state.alertAttemptTimes.push(now);
  const nextDueAt = now + backoffAfter(entry.alertsThisEpisode + 1);
  state.sendQueue.push({ to, alert: { ...alert, suppressed, previousAlertAt: entry.lastAlertAt, nextDueAt } });
  pumpSendQueue(state);
}

/**
 * Report a genuine failure. `context` is a stable dotted label for the code
 * path ("cron.themes", "survey.submit"); `meta` carries ids only.
 */
export function reportError(context: string, err: unknown, meta: ErrorMeta = {}): void {
  try {
    const now = Date.now();
    const environment = currentEnvironment();
    const described = describeError(err);
    const name = scrub(described.name, 200);
    const message = scrub(described.message, MAX_MESSAGE_CHARS);
    const stack = described.stack === null ? null : scrub(described.stack, MAX_STACK_CHARS);
    const safeMeta = scrubMeta(meta);
    const fingerprint = fingerprintOf(context, name, message);

    logLine('error', context, message, { name, fingerprint, environment, meta: safeMeta, stack });

    const state = slot();
    const entry = recordOccurrence(state, now, { at: iso(now), context, name, message, fingerprint, meta: safeMeta });
    maybeAlert(state, { context, name, message, stack, fingerprint, environment, meta: safeMeta, now, entry });
  } catch (internal) {
    // Last resort, so a bug in here can never escape into the caller's catch
    // block (or crash the process from the uncaughtException monitor). Only
    // this module's own failure is described — not the original error, whose
    // contents never made it through scrubbing.
    const reason = internal instanceof Error ? scrub(internal.message, 500) : 'non-Error thrown';
    logLine('error', 'report-error', `reportError failed while reporting ${context}: ${reason}`);
  }
}

/**
 * SQLSTATEs Postgres raises when a value bound into a query is malformed for
 * the type it is cast or stored as: a non-uuid where a uuid goes (22P02), a
 * NUL or bad byte in text (22021), a NUL escape in jsonb (22P05), a string
 * too long for varchar(n) (22001), a number out of range (22003), a garbled
 * date (22007, 22008). Where a request supplied the value, that is the
 * caller's bad input — 400 territory — and alerting on it lets anyone with a
 * form or a URL page the operator at will.
 *
 * Deliberately not the whole data-exception class 22: division by zero,
 * invalid regular expressions and the like come from our own SQL or stored
 * data, never from a request's value, and keep alerting.
 */
const BAD_INPUT_SQLSTATES = new Set(['22P02', '22021', '22P05', '22001', '22003', '22007', '22008']);

/**
 * True for a Postgres error caused by a malformed bound value (see
 * BAD_INPUT_SQLSTATES). Only meaningful where the value came from the
 * request; a cron job that hits one has a bug or bad stored data and should
 * report it. Duck-typed on `code` rather than `instanceof pg.DatabaseError`:
 * this module is reached by the Edge compile of instrumentation.ts, where pg
 * cannot be imported, and no non-Postgres error carries a 5-character
 * SQLSTATE in `code` (Node uses 'ECONNREFUSED', Stripe 'resource_missing').
 */
export function isBadInputDbError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && BAD_INPUT_SQLSTATES.has(code);
}

/**
 * Log a request rejected for bad input (isBadInputDbError) as ONE warn line —
 * scrubbed like everything else here, since Postgres quotes the rejected
 * value — without recording it as a failure or emailing anyone. Visible in
 * Railway and the monitor's tail, invisible to the alert budget. Never throws.
 */
export function warnBadInput(context: string, err: unknown, meta: ErrorMeta = {}): void {
  try {
    const described = describeError(err);
    const code = (err as { code?: unknown } | null)?.code;
    logLine('warn', context, `rejected request input: ${scrub(described.message, MAX_MESSAGE_CHARS)}`, {
      name: scrub(described.name, 200),
      code: typeof code === 'string' ? code : null,
      environment: currentEnvironment(),
      meta: scrubMeta(meta),
    });
  } catch (internal) {
    const reason = internal instanceof Error ? scrub(internal.message, 500) : 'non-Error thrown';
    logLine('error', 'report-error', `warnBadInput failed while logging ${context}: ${reason}`);
  }
}

/** A copy — callers must not be able to mutate the live buffer. */
export function getErrorReportSnapshot(): ErrorReportSnapshot {
  const state = slot();
  const now = Date.now();
  return {
    alertingConfigured: alertRecipient() !== null,
    totalReported: state.totalReported,
    alertsSent: state.alertsSent,
    alertsFailed: state.alertsFailed,
    lastAlertError: state.lastAlertError,
    recent: state.recent.map((report) => ({ ...report, meta: { ...report.meta } })).reverse(),
    fingerprints: Array.from(state.byFingerprint.values()).reverse().map((entry) => ({
      fingerprint: entry.fingerprint,
      context: entry.context,
      name: entry.name,
      message: entry.message,
      count: entry.count,
      firstSeenAt: iso(entry.firstSeenAt),
      lastSeenAt: iso(entry.lastSeenAt),
      lastAlertAt: entry.lastAlertAt === null ? null : iso(entry.lastAlertAt),
      suppressedSinceAlert: entry.suppressedSinceAlert,
    })),
    alertBudget: {
      maxPerHour: MAX_ALERTS_PER_HOUR,
      maxPerDay: MAX_ALERTS_PER_DAY,
      attemptsLastHour: state.alertAttemptTimes.filter((at) => now - at < HOUR_MS).length,
      attemptsLastDay: state.alertAttemptTimes.filter((at) => now - at < DAY_MS).length,
      queued: state.sendQueue.length,
    },
  };
}

/**
 * Route process-level failures into reportError, without changing whether the
 * process survives them. Called once from instrumentation.ts register(), Node
 * runtime only; idempotent, since register() can run more than once per
 * process (tests, dev reloads).
 *
 * Uncaught exceptions are observed through `uncaughtExceptionMonitor`, Node's
 * observe-only event: it fires before the crash/survive decision and has no
 * say in it. Under `next start` (what Railway runs) Next 14.2.35 has already
 * installed its own 'uncaughtException' listener (server/lib/start-server.js)
 * that logs and keeps the server alive, so production behaviour is exactly as
 * before plus a report. Anywhere without such a listener the process still
 * dies, as Node intends — and the async alert email may not get out first;
 * the synchronous log line does.
 *
 * Unhandled rejections have no monitor event, and adding an 'unhandledRejection'
 * listener IS a decision: with no listeners Node 15+ crashes on one. So ours
 * is added only when another listener already exists (Next's, registered
 * before instrumentation loads) — i.e. only when the keep-alive decision was
 * already made by someone else. Otherwise Node's default stands, the rejection
 * becomes an uncaught exception, and the monitor above reports it with
 * origin 'unhandledRejection'.
 */
export function installProcessErrorHandlers(): void {
  const state = slot();
  if (state.processHandlers) return;

  const onUncaughtMonitor = (err: unknown, origin: string) => {
    reportError(`process.${origin}`, err);
  };
  process.on('uncaughtExceptionMonitor', onUncaughtMonitor);

  let onUnhandledRejection: ((reason: unknown) => void) | null = null;
  if (process.listenerCount('unhandledRejection') > 0) {
    onUnhandledRejection = (reason: unknown) => {
      reportError('process.unhandledRejection', reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
  }

  state.processHandlers = { onUncaughtMonitor, onUnhandledRejection };

  // Said at boot, not only at the first error, so a deploy without
  // ALERT_EMAIL is visible in the deploy logs before anything goes wrong.
  if (!alertRecipient()) warnAlertsDisabledOnce(state);
}

/** Test-only: wipe the shared slot, drop queued alerts and detach any process handlers it installed. */
export function resetErrorReports(): void {
  const g = globalThis as GlobalWithSlot;
  const sendTimer = g[SLOT]?.sendTimer;
  if (sendTimer) clearTimeout(sendTimer);
  const handlers = g[SLOT]?.processHandlers;
  if (handlers) {
    process.off('uncaughtExceptionMonitor', handlers.onUncaughtMonitor);
    if (handlers.onUnhandledRejection) process.off('unhandledRejection', handlers.onUnhandledRejection);
  }
  g[SLOT] = freshState();
}
