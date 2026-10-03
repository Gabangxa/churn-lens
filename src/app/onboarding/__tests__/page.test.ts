import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What onboarding does when its session check cannot run: report, then
 * rethrow so Next still renders its error page. Next 14 only logs a throw
 * from a server component, and a dead onboarding page stops every new
 * founder. The reporting is real (ALERT_EMAIL is pinned empty by
 * vitest.config.ts).
 */
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => ({ value: 'a-session-cookie' }) }),
}));

const getOrgIdFromCookieStoreMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  getOrgIdFromCookieStore: (...args: unknown[]) => getOrgIdFromCookieStoreMock(...args),
}));

import OnboardingPage from '../page';
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

beforeEach(() => {
  resetErrorReports();
  getOrgIdFromCookieStoreMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OnboardingPage', () => {
  it('reports a failed session check and rethrows it for the error page', async () => {
    getOrgIdFromCookieStoreMock.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(OnboardingPage({ searchParams: {} })).rejects.toThrow('connection terminated unexpectedly');

    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'onboarding.load',
        message: 'connection terminated unexpectedly',
        meta: { step: 'session' },
      }),
    ]);
  });

  it('reports nothing when it only sends a signed-out visitor to log in', async () => {
    getOrgIdFromCookieStoreMock.mockResolvedValue(null);

    // redirect() works by throwing Next's own NEXT_REDIRECT signal.
    await expect(OnboardingPage({ searchParams: { plan: 'growth' } })).rejects.toThrow('NEXT_REDIRECT');

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('renders the form for a signed-in founder, reporting nothing', async () => {
    getOrgIdFromCookieStoreMock.mockResolvedValue('11111111-1111-4111-8111-111111111111');

    await expect(OnboardingPage({ searchParams: {} })).resolves.toBeTruthy();

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});
