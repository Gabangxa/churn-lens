import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireOrgIdMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

const createMock = vi.fn();
vi.mock('@/lib/polar', () => ({
  getPolar: () => ({ customerSessions: { create: (...args: unknown[]) => createMock(...args) } }),
  // Reads the env var rather than returning a fixed boolean so the 503 case is
  // driven by deleting POLAR_ACCESS_TOKEN, exactly as a misconfigured deploy
  // would be.
  isPolarConfigured: () => !!process.env.POLAR_ACCESS_TOKEN,
}));

// The route must reach neither the database nor a real Polar client. Both mocks
// throw rather than returning a stub, so a future edit that adds a DB read or
// constructs an SDK client fails loudly here instead of silently opening a
// connection in CI.
vi.mock('@/lib/db', () => {
  const forbidden = () => {
    throw new Error('the portal route must not touch the database');
  };
  return { query: forbidden, queryOne: forbidden, execute: forbidden, queryCount: forbidden };
});

vi.mock('@polar-sh/sdk', () => ({
  Polar: class {
    constructor() {
      throw new Error('the portal route must not construct a real Polar client');
    }
  },
}));

import * as route from '../route';
import { GET } from '../route';
// The real error class, not a fake: the route branches on `instanceof
// PolarError`, so a duck-typed stub would exercise nothing.
import { PolarError } from '@polar-sh/sdk/models/errors/polarerror.js';
import { HTTPValidationError } from '@polar-sh/sdk/models/errors/httpvalidationerror.js';

const ORG_ID = 'org-abc';
const APP_URL = 'https://app.churnlens.com';

// A realistic portal URL: the token and the customer's email both ride in the
// query string, which is the whole reason this thing may never be logged.
const PORTAL_TOKEN = 'polar_cst_deadbeefdeadbeef';
const PORTAL_URL = `https://polar.sh/acme/portal?customer_session_token=${PORTAL_TOKEN}&email=founder%40acme.com`;

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ORIGINAL_ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN;

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function authOk() {
  requireOrgIdMock.mockReturnValue({ orgId: ORG_ID });
}

function authFail() {
  requireOrgIdMock.mockReturnValue({
    error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }),
  });
}

/** A real PolarError, built from a real Response so statusCode/headers are genuine. */
function polarError(status: number, init: { headers?: Record<string, string>; body?: string } = {}) {
  const response = new Response(init.body ?? '', { status, headers: init.headers });
  return new PolarError(`status ${status}`, {
    response,
    request: new Request('https://api.polar.sh/v1/customer-sessions/'),
    body: init.body ?? '',
  });
}

/**
 * A real 422 as the SDK produces one: `M.jsonErr(422, HTTPValidationError$inboundSchema)`
 * means every 422 from this call arrives as an HTTPValidationError carrying
 * FastAPI's `detail` array. `loc` is what separates "we sent a bad request" from
 * "no such customer".
 */
function validationError(loc: Array<string | number>, input = 'echoed-request-value') {
  const detail = [{ loc, msg: 'Value error, invalid', type: 'value_error', input }];
  const body = JSON.stringify({ detail });
  const response = new Response(body, {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });
  return new HTTPValidationError(
    { detail },
    { response, request: new Request('https://api.polar.sh/v1/customer-sessions/'), body },
  );
}

function portalRequest(url = 'http://localhost/api/billing/portal') {
  return new NextRequest(url);
}

/** Every argument passed to any console spy, flattened to strings. */
function loggedText(): string {
  return [logSpy, warnSpy, errorSpy]
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)))
    .join('\n');
}

beforeEach(() => {
  requireOrgIdMock.mockReset();
  createMock.mockReset();
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
  authOk();
  createMock.mockResolvedValue({ customerPortalUrl: PORTAL_URL });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  if (ORIGINAL_ACCESS_TOKEN === undefined) delete process.env.POLAR_ACCESS_TOKEN;
  else process.env.POLAR_ACCESS_TOKEN = ORIGINAL_ACCESS_TOKEN;
});

// ─── happy path ──────────────────────────────────────────────────────────────

describe('GET /api/billing/portal — minting', () => {
  it('mints a fresh session and redirects with 303 so the browser follows with GET', async () => {
    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(PORTAL_URL);
  });

  it('identifies the customer by the org id from the cookie, never a DB lookup', async () => {
    await GET(portalRequest());

    // organizations.polar_customer_id stays NULL until the first subscription
    // webhook lands, so externalCustomerId is the only mapping that exists for
    // an org whose checkout has completed but whose webhook is in flight.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
      externalCustomerId: ORG_ID,
      returnUrl: `${APP_URL}/settings`,
      }),
      expect.anything(),
    );
  });

  it('ignores an org id supplied in the query string, so the route is not a credential factory', async () => {
    // customerSessions.create mints an unauthenticated bearer credential for
    // whichever customer it is handed. Taking that id from the request would be
    // a one-parameter takeover of any org's billing.
    await GET(portalRequest('http://localhost/api/billing/portal?orgId=someone-else'));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ externalCustomerId: ORG_ID }),
      expect.anything(),
    );
  });

  it('builds returnUrl from the public app URL, not the request host', async () => {
    // Behind Railway's proxy req.url is https://localhost:8080, which would put
    // a dead "back" button inside Polar's portal.
    await GET(portalRequest('https://localhost:8080/api/billing/portal'));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ returnUrl: `${APP_URL}/settings` }),
      expect.anything(),
    );
  });

  it('marks the redirect no-store so no proxy or bfcache retains the credential', async () => {
    const res = await GET(portalRequest());

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('mints a new session on every call and caches nothing between them', async () => {
    const second = `${PORTAL_URL}-second`;
    createMock.mockResolvedValueOnce({ customerPortalUrl: PORTAL_URL });
    createMock.mockResolvedValueOnce({ customerPortalUrl: second });

    const first = await GET(portalRequest());
    const again = await GET(portalRequest());

    // A memoized portal URL would be a live, unrevocable bearer credential held
    // in process memory. Polar's own docs say to mint per click.
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(first.headers.get('location')).toBe(PORTAL_URL);
    expect(again.headers.get('location')).toBe(second);
  });
});

// ─── the credential must never be logged ─────────────────────────────────────

describe('GET /api/billing/portal — the portal URL is a bearer credential', () => {
  it('logs nothing at all on the success path', async () => {
    await GET(portalRequest());

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('never writes the portal URL, the session token, or the customer email to a log', async () => {
    createMock.mockResolvedValue({
      customerPortalUrl: PORTAL_URL,
      token: PORTAL_TOKEN,
      id: 'cs_1',
    });

    await GET(portalRequest());

    const logged = loggedText();
    expect(logged).not.toContain(PORTAL_TOKEN);
    expect(logged).not.toContain('polar_cst_');
    expect(logged).not.toContain('founder%40acme.com');
    expect(logged).not.toContain('portal?');
  });

  it("does not echo a Polar error's body into the logs", async () => {
    // Polar's response body can quote back the request, so a failure is another
    // path by which a token or an email address reaches the log stream.
    createMock.mockRejectedValue(
      polarError(422, { body: `{"detail":"bad ${PORTAL_TOKEN} for founder@acme.com"}` }),
    );

    await GET(portalRequest());

    const logged = loggedText();
    expect(logged).not.toContain(PORTAL_TOKEN);
    expect(logged).not.toContain('founder@acme.com');
    // The org id and the numeric status are what a responder actually needs.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(ORG_ID));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('422'));
  });
});

// ─── refusals before any session is minted ───────────────────────────────────

describe('GET /api/billing/portal — refuses before minting', () => {
  it('sends an unauthenticated visitor to onboarding rather than a raw 401 JSON blob', async () => {
    authFail();

    const res = await GET(portalRequest());

    // "Manage billing" is an anchor a browser follows, so a JSON body would
    // render as text on screen. This deliberately diverges from the checkout
    // sibling and matches api/survey/preview.
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding`);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['not https', 'http://app.churnlens.com'],
  ])('refuses to mint when the app URL is %s, so Polar never gets a dead back button', async (
    _label,
    value,
  ) => {
    if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = value;

    const res = await GET(portalRequest());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/app URL is missing or not https/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reports missing billing config as 503, because retrying will never configure it', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;

    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=unconfigured`);

    expect(createMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(ORG_ID));
  });
});

// ─── failures from Polar ─────────────────────────────────────────────────────

describe('GET /api/billing/portal — Polar failures', () => {
  it('sends an org Polar has never seen (404) back to settings instead of erroring', async () => {
    createMock.mockRejectedValue(polarError(404));

    const res = await GET(portalRequest());

    // Free-plan orgs and anyone who never reached checkout land here. It is an
    // expected state, not a fault, so it returns a page rather than a code.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=none`);
  });

  it('also treats a 422 that names external_customer_id as an org Polar has never seen', async () => {
    createMock.mockRejectedValue(validationError(['body', 'external_customer_id']));

    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=none`);
  });

  it.each([
    ['a 422 about another field', () => validationError(['body', 'return_url'])],
    ['a 422 with no detail at all', () => polarError(422)],
  ])('does not tell a paying founder they have no billing account on %s', async (
    _label,
    makeError,
  ) => {
    // 422 is FastAPI's *request body* validation status, so it mostly catches our
    // own bad requests. Redirecting those to ?billing=none would show a past_due
    // founder "subscribe to a plan" while their card is bouncing, and hide the bug.
    createMock.mockRejectedValue(makeError());

    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=error`);
  });

  it('logs which field a 422 complained about, but never the value it echoed back', async () => {
    createMock.mockRejectedValue(validationError(['body', 'return_url'], 'echoed-request-value'));

    await GET(portalRequest());

    const logged = loggedText();
    // A field path and an error code make the request bug diagnosable...
    expect(logged).toContain('body.return_url:value_error');
    // ...while detail[].input and detail[].msg can quote the request back.
    expect(logged).not.toContain('echoed-request-value');
    expect(logged).not.toContain('Value error, invalid');
  });

  it('surfaces a rate limit as 429 with Retry-After, because the SDK does not retry it', async () => {
    createMock.mockRejectedValue(polarError(429, { headers: { 'retry-after': '30' } }));

    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=busy`);
    expect(res.headers.get('retry-after')).toBe('30');
    // The copy does not blame the founder for an org-wide bucket they cannot see.

  });

  it('still returns 429 when Polar omits Retry-After', async () => {
    createMock.mockRejectedValue(polarError(429));

    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=busy`);
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it.each([
    ['a Polar 500', () => polarError(500)],
    ['a Polar 401 from a bad access token', () => polarError(401)],
    ['a network failure that is not a PolarError', () => new Error('socket hang up')],
    ['a timeout', () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })],
  ])('turns %s into a handled redirect, never an unhandled 500', async (_label, makeError) => {
    createMock.mockRejectedValue(makeError());

    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=error`);
    expect(errorSpy.mock.calls[0][0]).toContain(ORG_ID);
  });

  it('logs a non-Polar error whole, since it carries no Polar credential', async () => {
    const err = new Error('getaddrinfo ENOTFOUND api.polar.sh');
    createMock.mockRejectedValue(err);

    await GET(portalRequest());

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(ORG_ID), err);
  });
});

// ─── method surface ──────────────────────────────────────────────────────────

describe('GET /api/billing/portal — method surface', () => {
  it('is GET-only, so nothing can mint a session by any other method', () => {
    expect(Object.keys(route)).toEqual(['GET']);
  });
});

describe('GET /api/billing/portal — minting is rate limited', () => {
  it('bounds credential minting per org', async () => {
    await GET(portalRequest());

    // Each successful call mints a bearer credential that cannot be revoked, so
    // the supply has to be capped even though the caller is authenticated.
    expect(checkRateLimitMock).toHaveBeenCalledWith(`portal:${ORG_ID}`, 10, 600_000);
  });

  it('sends a throttled founder back to settings with Retry-After, not a JSON body', async () => {
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 42 });

    const res = await GET(portalRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings?billing=busy`);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('checks authentication before spending the org rate limit', async () => {
    // Otherwise an unauthenticated third party could exhaust a founder's budget.
    authFail();

    await GET(portalRequest());

    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});
