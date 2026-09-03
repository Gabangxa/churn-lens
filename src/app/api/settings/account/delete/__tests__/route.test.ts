import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── Mocks ────────────────────────────────────────────────────────────────

const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const requireOrgIdMock = vi.fn();
const clearOrgCookieMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
  clearOrgCookie: (...args: unknown[]) => clearOrgCookieMock(...args),
}));

const disconnectStripeMock = vi.fn();
vi.mock('@/lib/stripe-disconnect', () => ({
  disconnectStripe: (...args: unknown[]) => disconnectStripeMock(...args),
}));

const revokeMock = vi.fn();
vi.mock('@/lib/polar', () => ({
  getPolar: () => ({ subscriptions: { revoke: (...args: unknown[]) => revokeMock(...args) } }),
}));

import { POST } from '../route';

const ORG_ID = 'org-1';

function deleteRequest() {
  return new NextRequest('http://localhost/api/settings/account/delete', { method: 'POST' });
}

beforeEach(() => {
  queryOneMock.mockReset();
  requireOrgIdMock.mockReset();
  clearOrgCookieMock.mockReset();
  disconnectStripeMock.mockReset();
  revokeMock.mockReset();

  requireOrgIdMock.mockReturnValue({ orgId: ORG_ID });
  queryOneMock.mockResolvedValue({
    deletion_requested_at: '2026-09-01T00:00:00.000Z',
    polar_subscription_id: null,
  });
  disconnectStripeMock.mockResolvedValue(undefined);
  revokeMock.mockResolvedValue(undefined);
  // Pass the response straight through, same shape clearOrgCookie returns in prod.
  clearOrgCookieMock.mockImplementation((res: NextResponse) => res);

  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/settings/account/delete', () => {
  it('returns 401 without a session', async () => {
    requireOrgIdMock.mockReturnValue({ error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) });

    const res = await POST(deleteRequest());

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('sets deletion_requested_at, keyed by the session org id', async () => {
    await POST(deleteRequest());

    expect(queryOneMock).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE organizations/),
      [ORG_ID],
    );
    const [sql] = queryOneMock.mock.calls[0];
    expect(sql).toMatch(/deletion_requested_at = COALESCE\(deletion_requested_at, now\(\)\)/);
  });

  it('calls disconnectStripe for the org', async () => {
    await POST(deleteRequest());
    expect(disconnectStripeMock).toHaveBeenCalledWith(ORG_ID);
  });

  it('does not call Polar when the org has no polar_subscription_id', async () => {
    await POST(deleteRequest());
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('revokes the Polar subscription when one is on file', async () => {
    queryOneMock.mockResolvedValue({
      deletion_requested_at: '2026-09-01T00:00:00.000Z',
      polar_subscription_id: 'sub_123',
    });

    await POST(deleteRequest());

    expect(revokeMock).toHaveBeenCalledWith({ id: 'sub_123' });
  });

  it('is non-fatal when the Polar revoke fails, and reports it in the response', async () => {
    queryOneMock.mockResolvedValue({
      deletion_requested_at: '2026-09-01T00:00:00.000Z',
      polar_subscription_id: 'sub_123',
    });
    revokeMock.mockRejectedValue(new Error('polar 500'));

    const res = await POST(deleteRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, billing: 'revoke_failed' });
  });

  it('omits `billing` from the response when nothing failed', async () => {
    const res = await POST(deleteRequest());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('billing');
  });

  it('responds with purgeAfter set deletionWindowDays after deletion_requested_at', async () => {
    const res = await POST(deleteRequest());
    const body = await res.json();

    expect(body.purgeAfter).toBe('2026-10-01T00:00:00.000Z'); // +30 days
  });

  it('clears the session cookie on the response', async () => {
    await POST(deleteRequest());
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the org row no longer exists', async () => {
    queryOneMock.mockResolvedValue(null);

    const res = await POST(deleteRequest());

    expect(res.status).toBe(404);
    expect(disconnectStripeMock).not.toHaveBeenCalled();
  });
});
