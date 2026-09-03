import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── Mocks ────────────────────────────────────────────────────────────────

const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const requireOrgIdMock = vi.fn();
const clearOrgCookieMock = vi.fn();
const assertSameOriginMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
  clearOrgCookie: (...args: unknown[]) => clearOrgCookieMock(...args),
  assertSameOrigin: (...args: unknown[]) => assertSameOriginMock(...args),
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

  assertSameOriginMock.mockReset();
  assertSameOriginMock.mockReturnValue(null); // same-origin by default
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
  it('rejects a cross-site request before touching the session or the org row', async () => {
    assertSameOriginMock.mockReturnValue(
      NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 }),
    );

    const res = await POST(deleteRequest());

    expect(res.status).toBe(403);
    expect(requireOrgIdMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
  });

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

  it('returns 404 when the org row no longer exists, but still clears the session cookie', async () => {
    queryOneMock.mockResolvedValue(null);

    const res = await POST(deleteRequest());

    expect(res.status).toBe(404);
    expect(disconnectStripeMock).not.toHaveBeenCalled();
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────

describe('POST /api/settings/account/delete — repeated requests', () => {
  it('keeps the first request’s timestamp, so a double-click cannot push the purge date out', async () => {
    const FIRST = '2026-09-01T00:00:00.000Z';
    // What COALESCE(deletion_requested_at, now()) returns on the second call:
    // the row already has a timestamp, so the original comes back unchanged.
    queryOneMock.mockResolvedValue({
      deletion_requested_at: FIRST,
      polar_subscription_id: null,
    });

    const first = await (await POST(deleteRequest())).json();
    const second = await (await POST(deleteRequest())).json();

    expect(second.purgeAfter).toBe(first.purgeAfter);
    expect(second).toMatchObject({ ok: true });
  });

  it('never deletes a row itself — erasure is the purge job’s to do', async () => {
    await POST(deleteRequest());
    await POST(deleteRequest());

    const statements = queryOneMock.mock.calls.map(([sql]) => String(sql));
    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).toMatch(/^\s*UPDATE organizations/);
      expect(sql).not.toMatch(/DELETE/i);
    }
  });
});

// ─── Ordering and the session cookie ──────────────────────────────────────

describe('POST /api/settings/account/delete — teardown order and cookie', () => {
  it('marks the row, disconnects Stripe and revokes Polar before responding', async () => {
    queryOneMock.mockResolvedValue({
      deletion_requested_at: '2026-09-01T00:00:00.000Z',
      polar_subscription_id: 'sub_123',
    });

    const order: string[] = [];
    queryOneMock.mockImplementation(async () => {
      order.push('mark');
      return { deletion_requested_at: '2026-09-01T00:00:00.000Z', polar_subscription_id: 'sub_123' };
    });
    disconnectStripeMock.mockImplementation(async () => {
      order.push('disconnect');
    });
    revokeMock.mockImplementation(async () => {
      order.push('revoke');
    });
    clearOrgCookieMock.mockImplementation((res: NextResponse) => {
      order.push('clear-cookie');
      return res;
    });

    await POST(deleteRequest());

    // Billing access has to stop before the founder is told it stopped —
    // "deleted" that still charges a card is the failure that costs money.
    expect(order).toEqual(['mark', 'disconnect', 'revoke', 'clear-cookie']);
  });

  it('keeps the session when the Polar revoke failed, so the billing-portal link still works', async () => {
    queryOneMock.mockResolvedValue({
      deletion_requested_at: '2026-09-01T00:00:00.000Z',
      polar_subscription_id: 'sub_123',
    });
    revokeMock.mockRejectedValue(new Error('polar 500'));

    const res = await POST(deleteRequest());

    // /api/billing/portal needs the session; clearing it here would dead-end
    // the one remediation the founder is being asked to perform.
    expect(clearOrgCookieMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, billing: 'revoke_failed' });
  });

  it('returns whatever clearOrgCookie produced', async () => {
    const sentinel = NextResponse.json({ ok: true, sentinel: true });
    clearOrgCookieMock.mockReturnValue(sentinel);

    const res = await POST(deleteRequest());

    expect(res).toBe(sentinel);
  });

  it('does nothing at all without a session', async () => {
    requireOrgIdMock.mockReturnValue({
      error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }),
    });

    const res = await POST(deleteRequest());

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(disconnectStripeMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
    expect(clearOrgCookieMock).not.toHaveBeenCalled();
  });

  it('still clears the session cookie when the org row is missing (nothing left to hold a session open for)', async () => {
    queryOneMock.mockResolvedValue(null);

    await POST(deleteRequest());

    expect(revokeMock).not.toHaveBeenCalled();
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
  });

  it('does not surface a failed Stripe disconnect as a 500 — deletion_requested_at is already committed', async () => {
    // disconnectStripe rejecting (its credential-clearing UPDATE failed — it
    // swallows Stripe API failures itself) must not turn the whole request
    // into a 500: the founder's deletion request already succeeded in the way
    // that matters (the row is marked, and the purge job disconnects Stripe
    // again itself once the grace period elapses), so failing the response
    // here would only make them think nothing happened and retry.
    disconnectStripeMock.mockRejectedValue(new Error('db down'));

    const res = await POST(deleteRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, stripe: 'disconnect_failed' });
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
  });

  it('reports both a failed Stripe disconnect and a failed Polar revoke independently', async () => {
    queryOneMock.mockResolvedValue({
      deletion_requested_at: '2026-09-01T00:00:00.000Z',
      polar_subscription_id: 'sub_123',
    });
    disconnectStripeMock.mockRejectedValue(new Error('db down'));
    revokeMock.mockRejectedValue(new Error('polar 500'));

    const res = await POST(deleteRequest());
    const body = await res.json();

    expect(body).toMatchObject({ ok: true, stripe: 'disconnect_failed', billing: 'revoke_failed' });
  });

  it('omits `stripe` from the response when disconnect succeeds', async () => {
    const res = await POST(deleteRequest());
    const body = await res.json();

    expect(body).not.toHaveProperty('stripe');
  });
});
