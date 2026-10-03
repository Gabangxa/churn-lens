import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What the sign-in confirmation page does when it cannot look the link up:
 * report, then rethrow so Next still renders its error page. Next 14 only
 * logs a throw from a server component, and a confirm page that fails for
 * everyone means nobody can sign in. The token lookup (src/lib/login-token.ts)
 * and the reporting are real; only the database is stubbed, and ALERT_EMAIL
 * is pinned empty by vitest.config.ts.
 */
const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

import ConfirmSignInPage from '../page';
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const TOKEN = 'emailed-magic-link-token-value';

beforeEach(() => {
  resetErrorReports();
  queryOneMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConfirmSignInPage', () => {
  it('reports a failed token lookup, without the token, and rethrows it for the error page', async () => {
    queryOneMock.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(ConfirmSignInPage({ searchParams: { token: TOKEN } })).rejects.toThrow(
      'connection terminated unexpectedly',
    );

    const { recent } = getErrorReportSnapshot();
    expect(recent).toEqual([
      expect.objectContaining({
        context: 'auth.confirm',
        message: 'connection terminated unexpectedly',
        meta: { step: 'token_lookup' },
      }),
    ]);
    // The token signs someone in until it is used.
    expect(JSON.stringify(recent)).not.toContain(TOKEN);
  });

  it('sends an unknown, used or expired link to the login error, reporting nothing', async () => {
    queryOneMock.mockResolvedValue(null);

    // redirect() works by throwing Next's own NEXT_REDIRECT signal.
    await expect(ConfirmSignInPage({ searchParams: { token: TOKEN } })).rejects.toThrow('NEXT_REDIRECT');

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('sends a link with no token to the login error without a lookup, reporting nothing', async () => {
    await expect(ConfirmSignInPage({ searchParams: {} })).rejects.toThrow('NEXT_REDIRECT');

    expect(queryOneMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('renders the confirmation for a usable link, reporting nothing', async () => {
    queryOneMock.mockResolvedValue({ email: 'founder@example.com' });

    await expect(ConfirmSignInPage({ searchParams: { token: TOKEN } })).resolves.toBeTruthy();

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});
