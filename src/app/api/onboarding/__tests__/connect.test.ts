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
