import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * reportError is driven through its public surface only: what it writes to the
 * log, what getErrorReportSnapshot() (read by GET /api/admin/status) says, and
 * what reaches Resend. Resend is the one genuine boundary stubbed here — it is
 * a network call, and the behaviour under test is what this module does with
 * its success, its `{ error }` resolution, and its throws.
 */

const sendMock = vi.fn();
const getResendMock = vi.fn();
vi.mock('@/lib/resend', () => ({
  getResend: () => getResendMock(),
  FROM_EMAIL: 'alerts@churnlens.test',
}));

import {
  reportError,
  getErrorReportSnapshot,
  installProcessErrorHandlers,
  resetErrorReports,
  ALERT_THROTTLE_MS,
  MAX_ALERTS_PER_HOUR,
  RECENT_ERRORS_LIMIT,
} from '../report-error';

const ALERT_TO = 'founder-alerts@ops.test';
const T0 = new Date('2026-10-03T12:00:00Z');

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** Every JSON line reportError (or its alert path) wrote via console.error. */
function errorLines(): Record<string, unknown>[] {
  return errorSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

/** The one alert email Resend was asked to send, by call index. */
function sentEmail(index = 0): { from: string; to: string; subject: string; text: string } {
  return sendMock.mock.calls[index][0] as { from: string; to: string; subject: string; text: string };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  resetErrorReports();

  sendMock.mockReset().mockResolvedValue({ data: { id: 'email_1' }, error: null });
  getResendMock.mockReset().mockImplementation(() => ({ emails: { send: (...args: unknown[]) => sendMock(...args) } }));

  vi.stubEnv('ALERT_EMAIL', ALERT_TO);
  vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');

  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // Also detaches any process listeners a test installed.
  resetErrorReports();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('reportError — the log line', () => {
  it('writes exactly one structured JSON line carrying context, error, fingerprint, environment and ids', () => {
    reportError('cron.themes', new Error('connection terminated'), { orgId: 'org_123', weekOf: '2026-09-28' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [line] = errorLines();
    expect(line).toMatchObject({
      level: 'error',
      context: 'cron.themes',
      name: 'Error',
      // Prefixed for Railway's log view and the monitor's tail, which show only `message`.
      message: '[cron.themes] connection terminated',
      environment: 'production',
      meta: { orgId: 'org_123', weekOf: '2026-09-28' },
    });
    expect(line.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(String(line.stack)).toContain('connection terminated');
  });

  it('falls back to NODE_ENV when Railway has not named the environment', () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', '');
    vi.stubEnv('NODE_ENV', 'test');

    reportError('survey.submit', new Error('boom'));

    expect(errorLines()[0].environment).toBe('test');
  });

  it('describes non-Error throwables instead of logging "[object Object]"', () => {
    // The Resend SDK hands back a plain { name, message } object, not an Error.
    reportError('cron.digest.send', { name: 'rate_limit_exceeded', message: 'Too many requests' });
    reportError('cron.scheduler', 'a bare string');

    const [resendLine, stringLine] = errorLines();
    expect(resendLine).toMatchObject({ name: 'rate_limit_exceeded', message: '[cron.digest.send] Too many requests' });
    expect(stringLine).toMatchObject({ message: '[cron.scheduler] a bare string' });
  });

  it('never throws, even when the thing thrown cannot be stringified', () => {
    // reportError runs inside catch blocks and inside the process-level
    // uncaughtException monitor, where a throw of its own would crash the
    // process outright.
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };

    expect(() => reportError('process.uncaughtException', hostile)).not.toThrow();
    // Still recorded: losing the report would hide that something was thrown.
    expect(getErrorReportSnapshot().recent[0]).toMatchObject({
      context: 'process.uncaughtException',
      message: '[unprintable thrown value]',
    });
  });

  it('never throws even when its own bookkeeping fails, and says so without echoing the original error', () => {
    const meta = {
      get orgId(): string {
        throw new Error('getter exploded');
      },
    };

    expect(() => reportError('survey.submit', new Error('original for jane@customer.example'), meta)).not.toThrow();
    const raw = errorSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(raw).toContain('reportError failed while reporting survey.submit: getter exploded');
    expect(raw).not.toContain('jane@customer.example');
  });
});

describe('reportError — PII redaction', () => {
  const MESSAGE = 'Key (lower(email))=(jane.doe+billing@customer.example) already exists';

  it('redacts anything email-shaped from the log line, message and stack alike', () => {
    reportError('auth.login-request', new Error(MESSAGE));

    const raw = String(errorSpy.mock.calls[0][0]);
    expect(raw).not.toContain('jane.doe');
    expect(raw).not.toContain('customer.example');
    const [line] = errorLines();
    expect(line.message).toBe('[auth.login-request] Key (lower(email))=([redacted email]) already exists');
    expect(String(line.stack)).toContain('[redacted email]');
  });

  it('redacts URL-encoded addresses too (a failed fetch URL with ?email=)', () => {
    reportError('cron.digest.send', new Error('GET https://api.example/v1/users?email=jane%40customer.example failed'));

    const raw = String(errorSpy.mock.calls[0][0]);
    expect(raw).not.toContain('jane%40customer.example');
    expect(raw).toContain('[redacted email]');
  });

  it('does not leak a partial address when the length bound splits one', () => {
    // The message is bounded (to 2 x the 1000-char message limit) before the
    // regex runs. Redaction then shrinks it well under 1000, so the final
    // truncation never happens: whatever the bound left at the end is output.
    const prefix = `${'p'.repeat(21)} `;
    const addresses = Array.from(
      { length: 39 },
      (_, i) => `someone.with.a.long.name${String(i).padStart(2, '0')}@customer-domain.example`,
    );
    const message = prefix + addresses.join(' ');
    const lastStart = message.lastIndexOf('someone.with.a.long.name38');
    // Sanity: the 2000-char bound falls after the last address's '@' and
    // before its end — the split this test is about.
    expect(message.indexOf('@', lastStart)).toBeLessThan(2000);
    expect(message.length).toBeGreaterThan(2000);

    reportError('cron.themes', new Error(message));

    const raw = String(errorSpy.mock.calls[0][0]);
    expect(raw).not.toContain('name38');
    expect(raw).not.toContain('customer-domai');
    // Only the message: the stack legitimately holds paths like node_modules/@vitest.
    expect(String(errorLines()[0].message)).not.toContain('@');
  });

  it('redacts a caller that mistakenly passes an email as a meta value', () => {
    reportError('survey.submit', new Error('boom'), { orgId: 'org_1', who: 'jane@customer.example' });

    expect(errorLines()[0].meta).toEqual({ orgId: 'org_1', who: '[redacted email]' });
  });

  it('keeps addresses out of the status snapshot and the alert email', () => {
    reportError('auth.login-request', new Error(MESSAGE));

    const snapshot = getErrorReportSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain('jane.doe');

    const email = sentEmail();
    expect(email.subject).not.toContain('jane.doe');
    expect(email.text).not.toContain('jane.doe');
    expect(email.text).toContain('[redacted email]');
  });

  it('groups errors that differ only by address or id under one fingerprint', () => {
    reportError('cron.themes', new Error('org 6f1c2a9e-1b2c-4d5e-8f90-123456789abc failed for alice@a.example'));
    reportError('cron.themes', new Error('org 0a9b8c7d-6e5f-4a3b-9c2d-abcdefabcdef failed for bob@b.example'));

    const { fingerprints } = getErrorReportSnapshot();
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0].count).toBe(2);
  });

  it('keeps distinct contexts on distinct fingerprints even for an identical message', () => {
    reportError('cron.themes', new Error('connection terminated'));
    reportError('survey.submit', new Error('connection terminated'));

    expect(getErrorReportSnapshot().fingerprints).toHaveLength(2);
  });
});

describe('getErrorReportSnapshot — the in-process ring buffer', () => {
  it('lists recent errors newest first and counts each fingerprint', () => {
    reportError('cron.themes', new Error('first'));
    vi.setSystemTime(new Date(T0.getTime() + 1000));
    reportError('cron.digest', new Error('second'));
    reportError('cron.digest', new Error('second'));

    const snapshot = getErrorReportSnapshot();
    expect(snapshot.totalReported).toBe(3);
    expect(snapshot.recent.map((e) => e.message)).toEqual(['second', 'second', 'first']);
    expect(snapshot.recent[2]).toMatchObject({ context: 'cron.themes', at: T0.toISOString() });

    const digest = snapshot.fingerprints.find((f) => f.context === 'cron.digest')!;
    expect(digest).toMatchObject({ count: 2, message: 'second', firstSeenAt: new Date(T0.getTime() + 1000).toISOString() });
  });

  it('keeps only the most recent RECENT_ERRORS_LIMIT entries but counts all of them', () => {
    for (let i = 0; i < RECENT_ERRORS_LIMIT + 7; i++) reportError('cron.scheduler', new Error(`tick ${i}`));

    const snapshot = getErrorReportSnapshot();
    expect(snapshot.recent).toHaveLength(RECENT_ERRORS_LIMIT);
    expect(snapshot.totalReported).toBe(RECENT_ERRORS_LIMIT + 7);
    expect(snapshot.fingerprints[0].count).toBe(RECENT_ERRORS_LIMIT + 7);
  });

  it('hands out a copy, so a reader cannot mutate the live buffer', () => {
    reportError('cron.themes', new Error('boom'));
    const snapshot = getErrorReportSnapshot();
    snapshot.recent.length = 0;
    snapshot.fingerprints[0].count = 99;

    const fresh = getErrorReportSnapshot();
    expect(fresh.recent).toHaveLength(1);
    expect(fresh.fingerprints[0].count).toBe(1);
  });

  it('survives a module re-import (the globalThis guarantee next dev relies on)', async () => {
    reportError('cron.themes', new Error('boom'));

    vi.resetModules();
    const fresh = await import('../report-error');

    expect(fresh.getErrorReportSnapshot().totalReported).toBe(1);
  });
});

describe('reportError — alert email throttle', () => {
  it('emails the first occurrence immediately, with the environment and context in the subject', () => {
    reportError('cron.themes', new Error('connection terminated'), { weekOf: '2026-09-28' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sentEmail();
    expect(email.to).toBe(ALERT_TO);
    expect(email.from).toBe('alerts@churnlens.test');
    expect(email.subject).toContain('production');
    expect(email.subject).toContain('cron.themes');
    expect(email.text).toContain('connection terminated');
    expect(email.text).toContain('weekOf: 2026-09-28');
  });

  it('suppresses repeats of the same fingerprint for an hour, then sends one carrying the suppressed count', async () => {
    reportError('cron.themes', new Error('connection terminated'));
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60 * 1000));
    reportError('cron.themes', new Error('connection terminated'));
    reportError('cron.themes', new Error('connection terminated'));

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getErrorReportSnapshot().fingerprints[0]).toMatchObject({ count: 3, suppressedSinceAlert: 2 });

    // One millisecond short of the window: still suppressed.
    vi.setSystemTime(new Date(T0.getTime() + ALERT_THROTTLE_MS - 1));
    reportError('cron.themes', new Error('connection terminated'));
    expect(sendMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(T0.getTime() + ALERT_THROTTLE_MS));
    reportError('cron.themes', new Error('connection terminated'));

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sentEmail(1).text).toContain('3 more occurrence(s) were suppressed');
    expect(getErrorReportSnapshot().fingerprints[0]).toMatchObject({
      count: 5,
      suppressedSinceAlert: 0,
      lastAlertAt: new Date(T0.getTime() + ALERT_THROTTLE_MS).toISOString(),
    });
    await vi.waitFor(() => expect(getErrorReportSnapshot().alertsSent).toBe(2));
  });

  it('throttles each fingerprint independently', () => {
    reportError('cron.themes', new Error('connection terminated'));
    reportError('survey.submit', new Error('connection terminated'));
    reportError('cron.themes', new Error('connection terminated'));

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls.map(([e]) => (e as { subject: string }).subject)).toEqual([
      expect.stringContaining('cron.themes'),
      expect.stringContaining('survey.submit'),
    ]);
  });

  it('caps alert emails across all fingerprints per hour, so an outage cannot drain the Resend quota surveys share', () => {
    for (let i = 0; i < MAX_ALERTS_PER_HOUR + 3; i++) {
      reportError(`context.${i}`, new Error('connection terminated'));
    }

    expect(sendMock).toHaveBeenCalledTimes(MAX_ALERTS_PER_HOUR);
    const capped = getErrorReportSnapshot().fingerprints.filter((f) => f.lastAlertAt === null);
    expect(capped).toHaveLength(3);
    expect(capped.every((f) => f.suppressedSinceAlert === 1)).toBe(true);

    // The budget is a sliding hour: once the first sends age out, a capped
    // fingerprint's next occurrence goes out and carries its backlog.
    vi.setSystemTime(new Date(T0.getTime() + 60 * 60 * 1000));
    reportError(capped[0].context, new Error('connection terminated'));
    expect(sendMock).toHaveBeenCalledTimes(MAX_ALERTS_PER_HOUR + 1);
    expect(sentEmail(MAX_ALERTS_PER_HOUR).text).toContain('1 more occurrence(s) were suppressed');
  });
});

describe('reportError — alerting not configured', () => {
  it('sends nothing, still records the error, and warns once per process', () => {
    vi.stubEnv('ALERT_EMAIL', '');

    reportError('cron.themes', new Error('one'));
    reportError('cron.digest', new Error('two'));

    expect(getResendMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot()).toMatchObject({ alertingConfigured: false, totalReported: 2 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('ALERT_EMAIL');
  });

  it('treats a whitespace-only ALERT_EMAIL as unset', () => {
    vi.stubEnv('ALERT_EMAIL', '   ');

    reportError('cron.themes', new Error('one'));

    expect(sendMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().alertingConfigured).toBe(false);
  });
});

describe('reportError — a failing alert send', () => {
  const failureLogged = () =>
    errorLines().find((l) => String(l.message).startsWith('[report-error.alert] alert email send failed'));

  it('logs a Resend { error } resolution and never re-enters reportError', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `to` field: founder-alerts@ops.test' },
    });

    reportError('cron.themes', new Error('boom'));

    await vi.waitFor(() => expect(failureLogged()).toBeDefined());
    expect(sendMock).toHaveBeenCalledTimes(1);
    const snapshot = getErrorReportSnapshot();
    expect(snapshot.totalReported).toBe(1);
    expect(snapshot.recent).toHaveLength(1);
    expect(snapshot).toMatchObject({ alertsSent: 0, alertsFailed: 1 });
    // The failure text is scrubbed like everything else this module writes.
    expect(snapshot.lastAlertError).toContain('[redacted email]');
    expect(JSON.stringify(failureLogged())).not.toContain('founder-alerts@ops.test');
  });

  it('logs a rejected send the same way', async () => {
    sendMock.mockRejectedValue(new Error('fetch failed'));

    reportError('cron.themes', new Error('boom'));

    await vi.waitFor(() => expect(failureLogged()).toBeDefined());
    expect(getErrorReportSnapshot()).toMatchObject({ totalReported: 1, alertsFailed: 1, lastAlertError: 'fetch failed' });
  });

  it('logs a synchronous throw from the client (RESEND_API_KEY unset) without throwing itself', async () => {
    getResendMock.mockImplementation(() => {
      throw new Error('RESEND_API_KEY is not set');
    });

    expect(() => reportError('cron.themes', new Error('boom'))).not.toThrow();

    await vi.waitFor(() => expect(failureLogged()).toBeDefined());
    expect(getErrorReportSnapshot()).toMatchObject({ totalReported: 1, alertsFailed: 1 });
  });

  it('still counts a failed send against the throttle, so a Resend outage is not retried on every error', async () => {
    sendMock.mockRejectedValue(new Error('fetch failed'));

    reportError('cron.themes', new Error('boom'));
    reportError('cron.themes', new Error('boom'));
    reportError('cron.themes', new Error('boom'));

    expect(sendMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getErrorReportSnapshot().alertsFailed).toBe(1));
  });
});

describe('installProcessErrorHandlers — reports process-level failures without deciding survival', () => {
  /**
   * Runs `fn` with `unhandledRejection` listeners replaced by `standIns`, then
   * puts the runner's own back. Vitest listens for unhandled rejections to fail
   * the run, so emitting one by hand must happen with its listener detached.
   */
  /**
   * Emit the monitor event the way Node does. Node passes listeners an
   * `origin` second argument; @types/node's emit() overload omits it.
   */
  function emitUncaughtMonitor(err: Error, origin: 'uncaughtException' | 'unhandledRejection') {
    const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
    emit('uncaughtExceptionMonitor', err, origin);
  }

  function withRejectionListeners(standIns: Array<(reason: unknown) => void>, fn: () => void) {
    const prior = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    for (const listener of standIns) process.on('unhandledRejection', listener);
    try {
      fn();
    } finally {
      resetErrorReports();
      process.removeAllListeners('unhandledRejection');
      for (const listener of prior) process.on('unhandledRejection', listener);
    }
  }

  it('reports an uncaught exception through the observe-only monitor, adding no uncaughtException listener', () => {
    // An 'uncaughtException' listener would be a decision to keep the process
    // alive. Under `next start` Next has already made it; anywhere else Node's
    // default crash must stand.
    const before = process.listenerCount('uncaughtException');

    installProcessErrorHandlers();
    emitUncaughtMonitor(new Error('kaboom'), 'uncaughtException');

    expect(getErrorReportSnapshot().recent[0]).toMatchObject({ context: 'process.uncaughtException', message: 'kaboom' });
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('labels a crash that began as an unhandled rejection by that origin', () => {
    installProcessErrorHandlers();
    emitUncaughtMonitor(new Error('nobody awaited me'), 'unhandledRejection');

    expect(getErrorReportSnapshot().recent[0].context).toBe('process.unhandledRejection');
  });

  it('reports unhandled rejections when the host has already chosen to keep the process alive', () => {
    const nextKeepAlive = vi.fn();

    withRejectionListeners([nextKeepAlive], () => {
      installProcessErrorHandlers();
      process.emit('unhandledRejection', new Error('nobody awaited me'), Promise.resolve());

      expect(nextKeepAlive).toHaveBeenCalledTimes(1);
      expect(getErrorReportSnapshot().recent[0]).toMatchObject({
        context: 'process.unhandledRejection',
        message: 'nobody awaited me',
      });
    });
  });

  it('does not take over unhandled rejections when nothing else would keep the process alive', () => {
    // With no listener Node 15+ crashes on an unhandled rejection; adding one
    // here would silently turn that crash into survival.
    withRejectionListeners([], () => {
      installProcessErrorHandlers();

      expect(process.listenerCount('unhandledRejection')).toBe(0);
    });
  });

  it('installs once, however many times register() runs in a process', () => {
    const before = process.listenerCount('uncaughtExceptionMonitor');

    installProcessErrorHandlers();
    installProcessErrorHandlers();
    installProcessErrorHandlers();

    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
  });

  it('says at boot that alerts are disabled, rather than waiting for the first error', () => {
    vi.stubEnv('ALERT_EMAIL', '');

    installProcessErrorHandlers();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('ALERT_EMAIL is not set');
    // …and only once: the first reported error does not repeat it.
    reportError('cron.themes', new Error('boom'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
