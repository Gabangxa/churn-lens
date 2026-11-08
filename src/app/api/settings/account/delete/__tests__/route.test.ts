import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── Mocks ────────────────────────────────────────────────────────────────

const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const requireOrgIdMock = vi.fn();
const clearOrgCookieMock = vi.fn();
const assertSameOriginMock = vi.fn();
const revokeAllSessionsMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
  clearOrgCookie: (...args: unknown[]) => clearOrgCookieMock(...args),
  assertSameOrigin: (...args: unknown[]) => assertSameOriginMock(...args),
  revokeAllSessions: (...args: unknown[]) => revokeAllSessionsMock(...args),
}));

const disconnectStripeMock = vi.fn();
vi.mock('@/lib/stripe-disconnect', () => ({
  disconnectStripe: (...args: unknown[]) => disconnectStripeMock(...args),
}));

// The REAL Polar SDK, talking to a fake api.polar.sh. The route depends on the
// SDK's query encoding, its status-code → error-class mapping (403 →
// AlreadyCanceledSubscription, 404 → ResourceNotFound) and its per-request
// timeout; a hand-made `subscriptions.revoke` stub would fake all three.
vi.mock('@polar-sh/sdk', async (importOriginal) => {
  const { polarModuleOverFakeApi } = await import('@/__tests__/helpers/fake-polar-api');
  return polarModuleOverFakeApi(await importOriginal<typeof import('@polar-sh/sdk')>());
});

import { POST } from '../route';
import {
  fakePolarApi,
  hangUntilAborted,
  polarApiError,
  polarJson,
  polarSubscriptionPage,
  type FakePolarRequest,
} from '@/__tests__/helpers/fake-polar-api';
import { polarSubscriptionJson } from '@/__tests__/helpers/polar-fixtures';
// Real: these tests assert on what the route reported. ALERT_EMAIL is pinned
// empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const ORG_ID = '7d4c1a52-3f0e-4b8a-9c61-2e5f8a9b0c13';
const OTHER_ORG_ID = '0b9e6f1d-8a2c-4d47-a3e5-6c1f2b7d9e80';

function deleteRequest() {
  return new NextRequest('http://localhost/api/settings/account/delete', { method: 'POST' });
}

/** The row the route's UPDATE … RETURNING hands back. */
function orgRow(polarSubscriptionId: string | null = null) {
  return { deletion_requested_at: '2026-09-01T00:00:00.000Z', polar_subscription_id: polarSubscriptionId };
}

// ─── A fake Polar account ─────────────────────────────────────────────────

interface FakeSubscription {
  id: string;
  status: string;
  /** The customer's external_id: the org it was bought for. */
  externalId: string;
}

/** What Polar answers when one of its subscriptions ends: they cannot be revoked again. */
const ENDED = new Set(['canceled', 'incomplete_expired', 'unpaid']);

const isList = (req: FakePolarRequest) => req.method === 'GET' && req.path === '/v1/subscriptions/';
const revokedId = (req: FakePolarRequest) =>
  req.method === 'DELETE' ? (/^\/v1\/subscriptions\/([^/]+)$/.exec(req.path)?.[1] ?? null) : null;

function subscriptionJson(sub: FakeSubscription) {
  return polarSubscriptionJson({
    id: sub.id,
    status: sub.status,
    productId: 'prod_fixture',
    externalId: sub.externalId,
    createdAt: '2026-08-01T00:00:00Z',
    modifiedAt: null,
  });
}

/**
 * Serve the subscriptions below the way Polar does: the list honours its
 * external_customer_id and status filters, and revoking ends a subscription,
 * a second revoke of it being a 403. `revoke` overrides the answer for one id.
 */
function servePolar(
  subscriptions: FakeSubscription[],
  overrides: { revoke?: (id: string, signal: AbortSignal) => Response | Promise<Response> | undefined } = {},
) {
  fakePolarApi.reset((req, signal) => {
    if (isList(req)) {
      const customers = req.query.getAll('external_customer_id');
      const statuses = req.query.getAll('status');
      return polarSubscriptionPage(
        subscriptions
          .filter((s) => customers.length === 0 || customers.includes(s.externalId))
          .filter((s) => statuses.length === 0 || statuses.includes(s.status))
          .map(subscriptionJson),
      );
    }
    const id = revokedId(req);
    if (id) {
      const override = overrides.revoke?.(id, signal);
      if (override) return override;
      const sub = subscriptions.find((s) => s.id === id);
      if (!sub) return polarApiError(404, 'ResourceNotFound');
      if (ENDED.has(sub.status)) return polarApiError(403, 'AlreadyCanceledSubscription');
      sub.status = 'canceled';
      return polarJson(200, subscriptionJson(sub));
    }
    throw new Error(`fake Polar: unexpected ${req.method} ${req.path}`);
  });
}

const revokeRequests = () => fakePolarApi.requests.map(revokedId).filter((id): id is string => id !== null);

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  queryOneMock.mockReset();
  requireOrgIdMock.mockReset();
  clearOrgCookieMock.mockReset();
  disconnectStripeMock.mockReset();
  revokeAllSessionsMock.mockReset().mockResolvedValue(undefined);

  assertSameOriginMock.mockReset();
  assertSameOriginMock.mockReturnValue(null); // same-origin by default
  requireOrgIdMock.mockReturnValue({ orgId: ORG_ID });
  queryOneMock.mockResolvedValue(orgRow());
  disconnectStripeMock.mockResolvedValue(undefined);
  // Pass the response straight through, same shape clearOrgCookie returns in prod.
  clearOrgCookieMock.mockImplementation((res: NextResponse) => res);

  vi.stubEnv('POLAR_ACCESS_TOKEN', 'polar_oat_test');
  servePolar([]);
  resetErrorReports();

  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    expect(fakePolarApi.requests).toEqual([]);
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Polar billing ────────────────────────────────────────────────────────

describe('POST /api/settings/account/delete — Polar billing', () => {
  it('does not call Polar for an org that never reached it', async () => {
    const body = await (await POST(deleteRequest())).json();

    expect(fakePolarApi.requests).toEqual([]);
    expect(body).not.toHaveProperty('billing');
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(ORG_ID);
  });

  it('does not need Polar configured for an org that never reached it', async () => {
    vi.stubEnv('POLAR_ACCESS_TOKEN', '');

    const body = await (await POST(deleteRequest())).json();

    expect(body).not.toHaveProperty('billing');
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('revokes the org’s active subscription and signs it out everywhere', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }]);

    const body = await (await POST(deleteRequest())).json();

    expect(revokeRequests()).toEqual(['sub_live']);
    expect(body).not.toHaveProperty('billing');
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(ORG_ID);
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('asks Polar for this org’s subscriptions that can still bill, by its external id', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));

    await POST(deleteRequest());

    const [list] = fakePolarApi.requests;
    expect(list.method).toBe('GET');
    expect(list.path).toBe('/v1/subscriptions/');
    expect(list.query.getAll('external_customer_id')).toEqual([ORG_ID]);
    expect(list.query.getAll('status').sort()).toEqual(['active', 'past_due', 'paused', 'trialing']);
  });

  it('revokes a paused subscription: it resumes billing on its own if left alone', async () => {
    // A pause with resumes_at set starts charging again on that date, by
    // which time the account may already be erased.
    queryOneMock.mockResolvedValue(orgRow('sub_paused'));
    servePolar([{ id: 'sub_paused', status: 'paused', externalId: ORG_ID }]);

    const body = await (await POST(deleteRequest())).json();

    // revokeRequests() is the DELETE /v1/subscriptions/{id} calls.
    expect(revokeRequests()).toEqual(['sub_paused']);
    expect(body).not.toHaveProperty('billing');
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(ORG_ID);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('signs an ex-subscriber out everywhere without a billing warning or an alert', async () => {
    // The finding: the org still points at its ended subscription, and revoking
    // that is Polar's 403 AlreadyCanceledSubscription. That used to come back as
    // revoke_failed — the session was kept on every device, the founder was told
    // to cancel a subscription that no longer exists, and an alert went out.
    queryOneMock.mockResolvedValue(orgRow('sub_ended'));
    servePolar([{ id: 'sub_ended', status: 'canceled', externalId: ORG_ID }]);

    const body = await (await POST(deleteRequest())).json();

    expect(revokeRequests()).toEqual([]);
    expect(body).not.toHaveProperty('billing');
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(ORG_ID);
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('revokes the billable subscriptions, not the one the org row points at', async () => {
    // A stale pointer: the row names an ended subscription while another one
    // is the one still charging the card.
    queryOneMock.mockResolvedValue(orgRow('sub_ended'));
    servePolar([
      { id: 'sub_ended', status: 'canceled', externalId: ORG_ID },
      { id: 'sub_live', status: 'active', externalId: ORG_ID },
    ]);

    const body = await (await POST(deleteRequest())).json();

    expect(revokeRequests()).toEqual(['sub_live']);
    expect(body).not.toHaveProperty('billing');
  });

  it('revokes every subscription that can still bill the org', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_growth'));
    servePolar([
      { id: 'sub_starter', status: 'past_due', externalId: ORG_ID },
      { id: 'sub_growth', status: 'active', externalId: ORG_ID },
      { id: 'sub_trial', status: 'trialing', externalId: ORG_ID },
      { id: 'sub_someone_else', status: 'active', externalId: OTHER_ORG_ID },
    ]);

    const body = await (await POST(deleteRequest())).json();

    expect(revokeRequests().sort()).toEqual(['sub_growth', 'sub_starter', 'sub_trial']);
    expect(body).not.toHaveProperty('billing');
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('counts a subscription Polar says is already cancelled as done', async () => {
    // Listed as active, ended before the revoke reached it (the period ran out,
    // or the founder cancelled in the portal a moment earlier).
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }], {
      revoke: () => polarApiError(403, 'AlreadyCanceledSubscription'),
    });

    const body = await (await POST(deleteRequest())).json();

    expect(revokeRequests()).toEqual(['sub_live']);
    expect(body).not.toHaveProperty('billing');
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(ORG_ID);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('counts a subscription Polar no longer has as done', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }], {
      revoke: () => polarApiError(404, 'ResourceNotFound'),
    });

    const body = await (await POST(deleteRequest())).json();

    expect(body).not.toHaveProperty('billing');
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('flags revoke_failed and keeps the session when Polar fails to revoke a billable subscription', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }], {
      revoke: () => new Response('upstream exploded: founder@acme.example', { status: 502 }),
    });

    const res = await POST(deleteRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, billing: 'revoke_failed' });
    // /api/billing/portal needs the session; clearing it here would dead-end
    // the one remediation the founder is being asked to perform. Signing out
    // everywhere would end this browser's session too.
    expect(clearOrgCookieMock).not.toHaveBeenCalled();
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();

    const { recent } = getErrorReportSnapshot();
    expect(recent).toEqual([
      expect.objectContaining({
        context: 'settings.account-delete',
        meta: { orgId: ORG_ID, subscriptionId: 'sub_live', step: 'polar_revoke' },
      }),
    ]);
    expect(recent[0].message).toContain('502');
    // Polar's response body is not ours to forward into logs or alert email.
    expect(JSON.stringify(recent)).not.toContain('upstream exploded');
  });

  it('still revokes the others when one fails, and flags the failure', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_a'));
    servePolar(
      [
        { id: 'sub_a', status: 'active', externalId: ORG_ID },
        { id: 'sub_b', status: 'active', externalId: ORG_ID },
      ],
      { revoke: (id) => (id === 'sub_a' ? polarApiError(500, 'InternalServerError') : undefined) },
    );

    const body = await (await POST(deleteRequest())).json();

    expect(revokeRequests().sort()).toEqual(['sub_a', 'sub_b']);
    expect(body).toMatchObject({ billing: 'revoke_failed' });
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ meta: { orgId: ORG_ID, subscriptionId: 'sub_a', step: 'polar_revoke' } }),
    ]);
  });

  it('flags revoke_failed when Polar cannot say which subscriptions are billable', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    fakePolarApi.reset(() => new Response('maintenance', { status: 503 }));

    const body = await (await POST(deleteRequest())).json();

    expect(body).toMatchObject({ billing: 'revoke_failed' });
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ meta: { orgId: ORG_ID, step: 'polar_list' } }),
    ]);
  });

  it('flags revoke_failed when billing is not configured but the org has a subscription on record', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    vi.stubEnv('POLAR_ACCESS_TOKEN', '');

    const body = await (await POST(deleteRequest())).json();

    expect(body).toMatchObject({ billing: 'revoke_failed' });
    expect(fakePolarApi.requests).toEqual([]);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ meta: { orgId: ORG_ID, step: 'polar_list' } }),
    ]);
  });

  describe('a Polar that never answers', () => {
    // The SDK sets no deadline unless the call passes timeoutMs, and arms it with
    // AbortSignal.timeout — which runs on Node's internal timers, out of reach
    // of fake timers. So time is made to pass at once: every deadline the SDK
    // arms is already expired, and the fake Polar hangs until it fires. A call
    // made without timeoutMs would hang this test until vitest kills it.
    let deadlines: number[];
    beforeEach(() => {
      deadlines = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        deadlines.push(ms);
        return AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      });
    });

    it('gives up on listing after 10 seconds and flags revoke_failed', async () => {
      queryOneMock.mockResolvedValue(orgRow('sub_live'));
      fakePolarApi.reset((_req, signal) => hangUntilAborted(signal));

      const body = await (await POST(deleteRequest())).json();

      expect(deadlines).toEqual([10_000]);
      expect(body).toMatchObject({ billing: 'revoke_failed' });
    });

    it('gives up on a revoke after 10 seconds and flags revoke_failed', async () => {
      queryOneMock.mockResolvedValue(orgRow('sub_live'));
      servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }], {
        revoke: (_id, signal) => hangUntilAborted(signal),
      });
      // Only the revoke stalls; the list answers before its deadline is looked at.
      vi.mocked(AbortSignal.timeout).mockImplementationOnce((ms: number) => {
        deadlines.push(ms);
        return new AbortController().signal;
      });

      const body = await (await POST(deleteRequest())).json();

      expect(deadlines).toEqual([10_000, 10_000]);
      expect(revokeRequests()).toEqual(['sub_live']);
      expect(body).toMatchObject({ billing: 'revoke_failed' });
    });
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────

describe('POST /api/settings/account/delete — repeated requests', () => {
  it('keeps the first request’s timestamp, so a double-click cannot push the purge date out', async () => {
    // What COALESCE(deletion_requested_at, now()) returns on the second call:
    // the row already has a timestamp, so the original comes back unchanged.
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

  it('is a clean success the second time, once the first request revoked the subscription', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }]);

    await POST(deleteRequest());
    const again = await (await POST(deleteRequest())).json();

    expect(again).not.toHaveProperty('billing');
    expect(revokeRequests()).toEqual(['sub_live']);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});

// ─── Ordering and the session cookie ──────────────────────────────────────

describe('POST /api/settings/account/delete — teardown order and cookie', () => {
  it('marks the row, disconnects Stripe and revokes Polar before responding', async () => {
    const order: string[] = [];
    queryOneMock.mockImplementation(async () => {
      order.push('mark');
      return orgRow('sub_live');
    });
    disconnectStripeMock.mockImplementation(async () => {
      order.push('disconnect');
    });
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }], {
      revoke: () => {
        order.push('revoke');
        return undefined;
      },
    });
    revokeAllSessionsMock.mockImplementation(async () => {
      order.push('sign-out-everywhere');
    });
    clearOrgCookieMock.mockImplementation((res: NextResponse) => {
      order.push('clear-cookie');
      return res;
    });

    await POST(deleteRequest());

    // Billing access has to stop before the founder is told it stopped —
    // "deleted" that still charges a card is the failure that costs money.
    // Sessions end last: until billing is settled the founder may still need
    // one (see the revoke_failed case above).
    expect(order).toEqual(['mark', 'disconnect', 'revoke', 'sign-out-everywhere', 'clear-cookie']);
  });

  it('signs the org out on every device, keyed by the session org id', async () => {
    await POST(deleteRequest());

    expect(revokeAllSessionsMock).toHaveBeenCalledTimes(1);
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(ORG_ID);
  });

  it('does not fail the request when signing out everywhere fails — the deletion already stands — but reports it', async () => {
    revokeAllSessionsMock.mockRejectedValue(new Error('db down'));

    const res = await POST(deleteRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, sessions: 'revoke_failed' });
    // This browser is still signed out; only the other devices were missed.
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
    // Reported through reportError (which also writes the log line), keyed
    // by org id so the missed sessions can be ended by hand.
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'settings.account-delete',
        message: 'db down',
        meta: { orgId: ORG_ID, step: 'session_revoke' },
      }),
    ]);
  });

  it('omits `sessions` from the response when signing out everywhere succeeds', async () => {
    const body = await (await POST(deleteRequest())).json();
    expect(body).not.toHaveProperty('sessions');
  });

  it('has no sessions to end when the org row is already gone', async () => {
    queryOneMock.mockResolvedValue(null);

    await POST(deleteRequest());

    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
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
    expect(fakePolarApi.requests).toEqual([]);
    expect(clearOrgCookieMock).not.toHaveBeenCalled();
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
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }], {
      revoke: () => polarApiError(500, 'InternalServerError'),
    });
    disconnectStripeMock.mockRejectedValue(new Error('db down'));

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

describe('POST /api/settings/account/delete — error reporting', () => {
  it('reports a failed Stripe disconnect with the org id — its key and webhook endpoint stay live', async () => {
    disconnectStripeMock.mockRejectedValue(new Error('stripe teardown boom'));

    await POST(deleteRequest());

    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'settings.account-delete', meta: { orgId: ORG_ID, step: 'stripe_disconnect' } }),
    ]);
  });

  it('reports nothing when the deletion goes through cleanly', async () => {
    queryOneMock.mockResolvedValue(orgRow('sub_live'));
    servePolar([{ id: 'sub_live', status: 'active', externalId: ORG_ID }]);

    await POST(deleteRequest());

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});
