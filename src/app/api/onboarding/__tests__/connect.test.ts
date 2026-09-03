import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const assertSameOriginMock = vi.fn();
const requireOrgIdMock = vi.fn();
const clearOrgCookieMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  assertSameOrigin: (...args: unknown[]) => assertSameOriginMock(...args),
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
  clearOrgCookie: (...args: unknown[]) => clearOrgCookieMock(...args),
}));

const queryMock = vi.fn();
const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const encryptApiKeyMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  encryptApiKey: (...args: unknown[]) => encryptApiKeyMock(...args),
}));

const checkRateLimitMock = vi.fn();
const clientIpMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  clientIp: (...args: unknown[]) => clientIpMock(...args),
}));

const webhookEndpointsCreateMock = vi.fn();
vi.mock('stripe', () => {
  class StripeAuthenticationError extends Error {}
  class StripePermissionError extends Error {}
  class MockStripe {
    webhookEndpoints = { create: (...args: unknown[]) => webhookEndpointsCreateMock(...args) };
    static errors = { StripeAuthenticationError, StripePermissionError };
  }
  return { default: MockStripe };
});

import { POST } from '../connect/route';

const ORG_ID = 'org-abc';
const APP_URL = 'https://app.churnlens.com';
const RESTRICTED_KEY = 'rk_live_abc123';
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function connectRequest(body: unknown) {
  return new NextRequest('http://localhost/api/onboarding/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function authOk() {
  requireOrgIdMock.mockReturnValue({ orgId: ORG_ID });
}

function authFail() {
  requireOrgIdMock.mockReturnValue({
    error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }),
  });
}

beforeEach(() => {
  assertSameOriginMock.mockReset().mockReturnValue(null);
  requireOrgIdMock.mockReset();
  clearOrgCookieMock.mockReset().mockImplementation((res: NextResponse) => res);
  queryMock.mockReset().mockResolvedValue([]);
  queryOneMock.mockReset();
  encryptApiKeyMock.mockReset().mockImplementation((plaintext: string) => `enc:${plaintext}`);
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
  clientIpMock.mockReset().mockReturnValue('203.0.113.1');
  webhookEndpointsCreateMock.mockReset().mockResolvedValue({ id: 'we_1', secret: 'whsec_test' });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  authOk();
  queryOneMock.mockResolvedValue({ id: ORG_ID, stripe_webhook_id: null });
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('POST /api/onboarding/connect — CSRF', () => {
  it('rejects a foreign origin before any DB call', async () => {
    assertSameOriginMock.mockReturnValue(
      NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 }),
    );

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(403);
    expect(requireOrgIdMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/onboarding/connect — requires a session', () => {
  it('returns 401 and writes nothing when there is no session', async () => {
    authFail();

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(webhookEndpointsCreateMock).not.toHaveBeenCalled();
  });

  it('clears the cookie and returns 401 when the session names an org that no longer exists', async () => {
    authOk();
    queryOneMock.mockResolvedValueOnce(null); // org row is gone

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/session is no longer valid/i);
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/onboarding/connect — happy path', () => {
  it('stores the encrypted key, registers the webhook, and sets no cookie', async () => {
    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(encryptApiKeyMock).toHaveBeenCalledWith(RESTRICTED_KEY);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE organizations SET stripe_api_key_enc/),
      [`enc:${RESTRICTED_KEY}`, ORG_ID],
    );

    expect(webhookEndpointsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${APP_URL}/api/webhooks/stripe/${ORG_ID}` }),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringMatching(/SET stripe_webhook_id/),
      ['we_1', 'enc:whsec_test', ORG_ID],
    );

    // The whole point of the rewrite: this route never mints a session.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('ignores an email field in the request body — nothing is ever written to users', async () => {
    await POST(connectRequest({ apiKey: RESTRICTED_KEY, email: 'attacker@evil.example' }));

    const allSql = [...queryMock.mock.calls, ...queryOneMock.mock.calls].map(([sql]) => sql as string);
    for (const sql of allSql) {
      expect(sql.toLowerCase()).not.toMatch(/\busers\b/);
    }
  });

  it('skips webhook registration when the org already has one', async () => {
    queryOneMock.mockResolvedValueOnce({ id: ORG_ID, stripe_webhook_id: 'we_existing' });

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(200);
    expect(webhookEndpointsCreateMock).not.toHaveBeenCalled();
  });

  it('rejects a non-restricted key before touching the database', async () => {
    const res = await POST(connectRequest({ apiKey: 'sk_live_not_restricted' }));

    expect(res.status).toBe(400);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('returns 422 when Stripe rejects webhook registration', async () => {
    webhookEndpointsCreateMock.mockRejectedValue(new Error('bad request'));

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(422);
  });

  it('is rate limited per IP', async () => {
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 42 });

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(429);
    expect(requireOrgIdMock).not.toHaveBeenCalled();
  });
});

// ─── The takeover itself, replayed against the fixed route ───────────────────
//
// Everything above mocks requireOrgId, which proves the route *calls* the guard
// but not that the guard actually stops the original attack. These use the REAL
// auth helpers and a real (or absent) signed cookie, so they fail if the session
// check is ever loosened back to trusting the body.

describe('POST /api/onboarding/connect — the account-takeover attack', () => {
  const VICTIM_EMAIL = 'founder@victim.example';
  const ATTACKER_ORG_ID = 'org-attacker';
  const COOKIE_NAME = 'churnlens_org_id';

  let realAuth: typeof import('@/lib/auth');

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    realAuth = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
    // Swap the stubs for the genuine implementations. assertSameOrigin stays
    // stubbed-to-null so these tests isolate the session check.
    requireOrgIdMock.mockImplementation(realAuth.requireOrgId);
    clearOrgCookieMock.mockImplementation(realAuth.clearOrgCookie);
  });

  /** A genuinely signed session cookie for `orgId`, minted the way verify does. */
  function signedCookieFor(orgId: string): string {
    const carrier = NextResponse.next();
    realAuth.setOrgCookie(carrier, orgId);
    return carrier.cookies.get(COOKIE_NAME)!.value;
  }

  function attackRequest(body: unknown, cookie?: string) {
    return new NextRequest('http://localhost/api/onboarding/connect', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie: `${COOKIE_NAME}=${cookie}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('the original exploit — { email: victim, apiKey } with no cookie — is a 401 with zero DB writes', async () => {
    const res = await POST(attackRequest({ email: VICTIM_EMAIL, apiKey: RESTRICTED_KEY }));

    expect(res.status).toBe(401);
    // Nothing read, nothing written, no org or user conjured from the email.
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(webhookEndpointsCreateMock).not.toHaveBeenCalled();
    expect(encryptApiKeyMock).not.toHaveBeenCalled();
    // And above all: no session handed to the attacker.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a forged cookie (right shape, wrong signature) is a 401 with zero DB writes', async () => {
    const res = await POST(
      attackRequest({ email: VICTIM_EMAIL, apiKey: RESTRICTED_KEY }, 'org-victim.deadbeef'),
    );

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('with a valid session the body email is inert — writes go to the cookie org and never to users', async () => {
    queryOneMock.mockResolvedValue({ id: ATTACKER_ORG_ID, stripe_webhook_id: null });

    const res = await POST(
      attackRequest(
        { email: VICTIM_EMAIL, apiKey: RESTRICTED_KEY },
        signedCookieFor(ATTACKER_ORG_ID),
      ),
    );

    expect(res.status).toBe(200);

    const allCalls = [...queryMock.mock.calls, ...queryOneMock.mock.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const [sql, params] of allCalls) {
      // No users table, ever — this route cannot bind an email to an org.
      expect((sql as string).toLowerCase()).not.toMatch(/\busers\b/);
      // The victim's address reaches no statement, and every org-scoped
      // statement is scoped to the cookie's org.
      const values = (params as unknown[] | undefined) ?? [];
      expect(values).not.toContain(VICTIM_EMAIL);
      if (values.includes(ATTACKER_ORG_ID)) expect(values).not.toContain('org-victim');
    }
    // The Stripe webhook is registered against the session's org, not anything
    // derived from the body.
    expect(webhookEndpointsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${APP_URL}/api/webhooks/stripe/${ATTACKER_ORG_ID}` }),
    );
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a valid session for a deleted org cannot re-create it — 401, cookie cleared, no writes', async () => {
    queryOneMock.mockResolvedValue(null);

    const res = await POST(
      attackRequest({ apiKey: RESTRICTED_KEY }, signedCookieFor('org-deleted')),
    );

    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
    // Real clearOrgCookie ran, so the dead session is actively evicted.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

describe('POST /api/onboarding/connect — malformed body', () => {
  it('answers 500 (not 400) for a body that is not JSON', async () => {
    // CHARACTERIZATION: req.json() is inside the route's outer try, so a parse
    // failure lands in the generic 500 handler. /api/auth/request returns 400
    // for the same input. Not a security issue — a bad client is told nothing
    // useful either way — but the two doors disagree.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new NextRequest('http://localhost/api/onboarding/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(queryMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
