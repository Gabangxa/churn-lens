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

const queryOneMock = vi.fn();
// Every statement the route runs on its transaction's client, answered with
// the row count executeMock resolves to. Whether the key and the acceptance
// really commit or roll back together is a fact about rows:
// connect.db.test.ts and legal-acceptance.db.test.ts pin it.
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string, params?: unknown[]) => ({ rows: [], rowCount: await executeMock(text, params) }),
    }),
}));

const encryptApiKeyMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  encryptApiKey: (...args: unknown[]) => encryptApiKeyMock(...args),
  decryptApiKey: (stored: string) => stored.replace(/^enc:/, ''),
}));

const checkRateLimitMock = vi.fn();
const clientIpMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  clientIp: (...args: unknown[]) => clientIpMock(...args),
}));

// The real SDK over a fake api.stripe.com — see src/__tests__/helpers/fake-stripe-api.ts.
// connect.db.test.ts covers what each Stripe answer leaves in the row.
vi.mock('stripe', async (importOriginal) => {
  const { stripeModuleOverFakeApi } = await import('@/__tests__/helpers/fake-stripe-api');
  return stripeModuleOverFakeApi(await importOriginal<typeof import('stripe')>());
});

import { POST } from '../connect/route';
// Real: these tests assert on what the route reported. ALERT_EMAIL is pinned
// empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';
import { currentLegalDocsVersion } from '@/lib/legal-version';
import { fakeStripeApi, stripeError, stripeJson, type FakeStripeRequest } from '@/__tests__/helpers/fake-stripe-api';

const ORG_ID = 'org-abc';
const APP_URL = 'https://app.churnlens.com';
const RESTRICTED_KEY = 'rk_live_abc123';
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
// Every connect must carry acceptance of the current Terms/DPA; what happens
// without it is pinned against real rows in connect.db.test.ts.
const ACCEPTED = { acceptedLegalVersion: currentLegalDocsVersion() };

/**
 * A key made per the onboarding instructions: the key check's customer list
 * and webhook registration work, the optional account read does not.
 */
function onboardingScopedKey(req: FakeStripeRequest): Response {
  if (req.method === 'GET' && req.path === '/v1/customers') {
    return stripeJson(200, { object: 'list', data: [], has_more: false, url: '/v1/customers' });
  }
  if (req.method === 'POST' && req.path === '/v1/webhook_endpoints') {
    return stripeJson(200, { id: 'we_1', object: 'webhook_endpoint', secret: 'whsec_test' });
  }
  if (req.path.startsWith('/v1/webhook_endpoints/')) {
    const id = req.path.slice('/v1/webhook_endpoints/'.length);
    return stripeJson(200, { id, object: 'webhook_endpoint', deleted: req.method === 'DELETE' });
  }
  return stripeError(403, 'invalid_request_error', 'The provided key does not have the required permissions.');
}

/** onboardingScopedKey, except that webhook registration gets `response`. */
function registrationAnswers(response: () => Response) {
  return (req: FakeStripeRequest): Response =>
    req.method === 'POST' && req.path === '/v1/webhook_endpoints' ? response() : onboardingScopedKey(req);
}

/** The url each webhook endpoint was registered with. */
function registeredWebhookUrls(): (string | null)[] {
  return fakeStripeApi.requests
    .filter((r) => r.method === 'POST' && r.path === '/v1/webhook_endpoints')
    .map((r) => new URLSearchParams(r.body).get('url'));
}

/** An org with no Stripe connection yet, as the route's first read returns it. */
const UNCONNECTED_ORG = {
  id: ORG_ID,
  stripe_api_key_enc: null,
  stripe_webhook_id: null,
  stripe_webhook_secret_enc: null,
};

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
  queryOneMock.mockReset();
  executeMock.mockReset().mockResolvedValue(1);
  encryptApiKeyMock.mockReset().mockImplementation((plaintext: string) => `enc:${plaintext}`);
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
  clientIpMock.mockReset().mockReturnValue('203.0.113.1');
  fakeStripeApi.reset(onboardingScopedKey);
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  authOk();
  queryOneMock.mockResolvedValue(UNCONNECTED_ORG);
  // The business-name lookup warns when the key may not read the account,
  // which onboardingScopedKey makes the default.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.mocked(console.warn).mockRestore();
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('POST /api/onboarding/connect — CSRF', () => {
  it('rejects a foreign origin before any DB call', async () => {
    assertSameOriginMock.mockReturnValue(
      NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 }),
    );

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(403);
    expect(requireOrgIdMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/onboarding/connect — requires a session', () => {
  it('returns 401 and writes nothing when there is no session', async () => {
    authFail();

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(fakeStripeApi.requests).toEqual([]);
  });

  it('clears the cookie and returns 401 when the session names an org that no longer exists', async () => {
    authOk();
    queryOneMock.mockResolvedValueOnce(null); // org row is gone

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/session is no longer valid/i);
    expect(clearOrgCookieMock).toHaveBeenCalledTimes(1);
    expect(executeMock).not.toHaveBeenCalled();
    expect(fakeStripeApi.requests).toEqual([]);
  });
});

describe('POST /api/onboarding/connect — happy path', () => {
  it('registers the webhook, then stores the encrypted key, endpoint and acceptance in one transaction, and sets no cookie', async () => {
    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(registeredWebhookUrls()).toEqual([`${APP_URL}/api/webhooks/stripe/${ORG_ID}`]);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/UPDATE organizations\s+SET stripe_api_key_enc = \$1,\s+stripe_webhook_id = \$2/),
      // No business name: this key may not read the account (onboardingScopedKey).
      [`enc:${RESTRICTED_KEY}`, 'we_1', 'enc:whsec_test', null, ORG_ID],
    );
    // The acceptance, recorded through the shared writer with the connect door.
    expect(executeMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/INSERT INTO legal_acceptances/),
      [ORG_ID, currentLegalDocsVersion(), 'connect'],
    );

    // The whole point of the rewrite: this route never mints a session.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('ignores an email field in the request body — nothing is ever written to users', async () => {
    await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED, email: 'attacker@evil.example' }));

    const allSql = [...executeMock.mock.calls, ...queryOneMock.mock.calls].map(([sql]) => sql as string);
    for (const sql of allSql) {
      expect(sql.toLowerCase()).not.toMatch(/\busers\b/);
    }
  });

  it('keeps an existing endpoint the new key can see, instead of registering another', async () => {
    queryOneMock.mockResolvedValueOnce({
      ...UNCONNECTED_ORG,
      stripe_api_key_enc: 'enc:rk_live_previous',
      stripe_webhook_id: 'we_existing',
      stripe_webhook_secret_enc: 'enc:whsec_existing',
    });

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(200);
    expect(registeredWebhookUrls()).toEqual([]);
    expect(executeMock).toHaveBeenCalledWith(expect.stringMatching(/UPDATE organizations/), [
      `enc:${RESTRICTED_KEY}`,
      'we_existing',
      'enc:whsec_existing',
      null,
      ORG_ID,
    ]);
  });

  it('rejects a non-restricted key before touching the database', async () => {
    const res = await POST(connectRequest({ apiKey: 'sk_live_not_restricted', ...ACCEPTED }));

    expect(res.status).toBe(400);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('returns 422 and stores nothing when Stripe rejects the key at webhook registration', async () => {
    fakeStripeApi.reset(registrationAnswers(() => stripeError(401, 'invalid_request_error', 'Invalid API Key provided.')));

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(422);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('is rate limited per IP, but only after the session is checked', async () => {
    // Checked AFTER requireOrgId now: an unauthenticated stranger who was
    // always going to get a 401 must not be able to burn a founder's (or a
    // shared-IP neighbor's) connect budget just by hammering this route.
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 42 });

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(429);
    expect(requireOrgIdMock).toHaveBeenCalledTimes(1);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(fakeStripeApi.requests).toEqual([]);
  });

  it('never consults the rate limiter at all for an unauthenticated request', async () => {
    authFail();
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 42 });

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
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
    const res = await POST(attackRequest({ email: VICTIM_EMAIL, apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(401);
    // Nothing read, nothing written, no org or user conjured from the email.
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(fakeStripeApi.requests).toEqual([]);
    expect(encryptApiKeyMock).not.toHaveBeenCalled();
    // And above all: no session handed to the attacker.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a forged cookie (right shape, wrong signature) is a 401 with zero DB writes', async () => {
    const res = await POST(
      attackRequest({ email: VICTIM_EMAIL, apiKey: RESTRICTED_KEY, ...ACCEPTED }, 'org-victim.deadbeef'),
    );

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('with a valid session the body email is inert — writes go to the cookie org and never to users', async () => {
    queryOneMock.mockResolvedValue({ ...UNCONNECTED_ORG, id: ATTACKER_ORG_ID });

    const res = await POST(
      attackRequest(
        { email: VICTIM_EMAIL, apiKey: RESTRICTED_KEY, ...ACCEPTED },
        signedCookieFor(ATTACKER_ORG_ID),
      ),
    );

    expect(res.status).toBe(200);

    const allCalls = [...executeMock.mock.calls, ...queryOneMock.mock.calls];
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
    expect(registeredWebhookUrls()).toEqual([`${APP_URL}/api/webhooks/stripe/${ATTACKER_ORG_ID}`]);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a valid session for a deleted org cannot re-create it — 401, cookie cleared, no writes', async () => {
    queryOneMock.mockResolvedValue(null);

    const res = await POST(
      attackRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }, signedCookieFor('org-deleted')),
    );

    expect(res.status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
    // Real clearOrgCookie ran, so the dead session is actively evicted.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

describe('POST /api/onboarding/connect — malformed body', () => {
  it('answers 400 (not 500) for a body that is not JSON, same as /api/auth/request', async () => {
    // req.json() now has its own try/catch, matching /api/auth/request, rather
    // than falling into the generic 500 handler further down.
    const req = new NextRequest('http://localhost/api/onboarding/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/onboarding/connect — error reporting', () => {
  beforeEach(() => {
    resetErrorReports();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a webhook registration failure that is not the founder\'s key', async () => {
    fakeStripeApi.reset(
      registrationAnswers(() => {
        throw new TypeError('fetch failed');
      }),
    );

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(502);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'onboarding.connect', meta: { orgId: ORG_ID, step: 'stripe_webhook' } }),
    ]);
  });

  it('does not alert on a key Stripe rejected — that is the founder\'s input, answered with a hint', async () => {
    fakeStripeApi.reset(
      registrationAnswers(() => stripeError(401, 'invalid_request_error', 'Invalid API Key provided: rk_live_****c123')),
    );

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/webhooks:write/);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('reports a server whose app URL cannot carry a Stripe webhook — every onboarding fails until fixed', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://app.churnlens.com';

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(500);
    // Before any Stripe call, and nothing stored.
    expect(fakeStripeApi.requests).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'onboarding.connect', meta: { orgId: ORG_ID, step: 'app_url' } }),
    ]);
  });

  it('reports an unexpected failure with the org id, and never the key', async () => {
    executeMock.mockRejectedValue(new Error('connection terminated'));

    const res = await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    expect(res.status).toBe(500);
    const { recent } = getErrorReportSnapshot();
    expect(recent).toEqual([
      expect.objectContaining({ context: 'onboarding.connect', message: 'connection terminated', meta: { orgId: ORG_ID } }),
    ]);
    expect(JSON.stringify(recent)).not.toContain(RESTRICTED_KEY);
  });

  it('deletes the endpoint it just registered when saving the connection fails', async () => {
    // Nothing was stored, so the endpoint would only post events that no
    // row can verify — and a retry registers a fresh one anyway.
    executeMock.mockRejectedValue(new Error('connection terminated'));

    await POST(connectRequest({ apiKey: RESTRICTED_KEY, ...ACCEPTED }));

    const deletes = fakeStripeApi.requests.filter((r) => r.method === 'DELETE');
    expect(deletes).toEqual([expect.objectContaining({ path: '/v1/webhook_endpoints/we_1', apiKey: RESTRICTED_KEY })]);
  });
});
