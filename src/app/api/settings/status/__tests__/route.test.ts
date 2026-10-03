import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireOrgIdMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
}));

const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

import { GET } from '../route';
// Real: these tests assert on what the route reported. ALERT_EMAIL is pinned
// empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function statusRequest() {
  return new NextRequest('http://localhost/api/settings/status');
}

beforeEach(() => {
  resetErrorReports();
  requireOrgIdMock.mockReset().mockResolvedValue({ orgId: ORG_ID });
  queryOneMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/settings/status', () => {
  it('says connected, with any pending deletion, for an org holding a Stripe key', async () => {
    queryOneMock.mockResolvedValue({
      stripe_api_key_enc: 'v1:enc',
      stripe_account_id: null,
      deletion_requested_at: '2026-10-01T00:00:00.000Z',
    });

    const res = await GET(statusRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true, deletionRequestedAt: '2026-10-01T00:00:00.000Z' });
    expect(queryOneMock.mock.calls[0][1]).toEqual([ORG_ID]);
  });

  it('says not connected for an org without one', async () => {
    queryOneMock.mockResolvedValue({ stripe_api_key_enc: null, stripe_account_id: null, deletion_requested_at: null });

    const res = await GET(statusRequest());

    expect(await res.json()).toEqual({ connected: false, deletionRequestedAt: null });
  });

  it('passes the session gate\'s 401 through and reports nothing', async () => {
    requireOrgIdMock.mockResolvedValue({ error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) });

    const res = await GET(statusRequest());

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});

describe('GET /api/settings/status — failures are reported, not dressed up as "not connected"', () => {
  it('reports a failed org read with the org id and answers 500', async () => {
    // It used to answer { connected: false } here: the settings page then
    // offered "Connect Stripe" to a connected founder, and nobody heard the
    // database was failing.
    queryOneMock.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await GET(statusRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not load the Stripe connection status.' });
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'settings.status',
        message: 'connection terminated unexpectedly',
        meta: { orgId: ORG_ID },
      }),
    ]);
  });

  it('reports a failing session check, which runs before any catch in the route', async () => {
    requireOrgIdMock.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await GET(statusRequest());

    expect(res.status).toBe(500);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'settings.status',
        message: 'connection terminated unexpectedly',
        meta: { step: 'unhandled', method: 'GET' },
      }),
    ]);
  });
});
