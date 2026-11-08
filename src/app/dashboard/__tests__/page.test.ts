import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What the dashboard does when it cannot load: report, then rethrow so Next
 * still renders its error page. Next 14 only logs a throw from a server
 * component, so without the report a dashboard broken for every founder
 * would go unnoticed. The session check and the database are stubbed; the
 * reporting is real (ALERT_EMAIL is pinned empty by vitest.config.ts).
 */
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => ({ value: 'a-session-cookie' }) }),
}));

const getOrgIdFromCookieStoreMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  getOrgIdFromCookieStore: (...args: unknown[]) => getOrgIdFromCookieStoreMock(...args),
}));

const queryMock = vi.fn();
const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  queryCount: async () => 0,
}));

import DashboardPage from '../page';
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  resetErrorReports();
  getOrgIdFromCookieStoreMock.mockReset().mockResolvedValue(ORG_ID);
  queryMock.mockReset().mockResolvedValue([]);
  queryOneMock.mockReset().mockResolvedValue(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DashboardPage when it cannot load', () => {
  it('reports a failed session check and rethrows it for the error page', async () => {
    getOrgIdFromCookieStoreMock.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(DashboardPage()).rejects.toThrow('connection terminated unexpectedly');

    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'dashboard.load',
        message: 'connection terminated unexpectedly',
        meta: { step: 'session' },
      }),
    ]);
  });

  it('reports a failed data load with the org id and rethrows it', async () => {
    queryOneMock.mockRejectedValue(new Error('relation "organizations" does not exist'));

    await expect(DashboardPage()).rejects.toThrow('relation "organizations" does not exist');

    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'dashboard.load', meta: { orgId: ORG_ID, step: 'data' } }),
    ]);
  });

  it('reports nothing when it only sends a signed-out visitor to log in', async () => {
    getOrgIdFromCookieStoreMock.mockResolvedValue(null);

    // redirect() works by throwing Next's own NEXT_REDIRECT signal.
    await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});
