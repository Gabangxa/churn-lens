import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { setOrgCookie, requireOrgId, clearOrgCookie, assertSameOrigin } from '../auth';

const TEST_KEY = 'b'.repeat(64);
const COOKIE_NAME = 'churnlens_org_id';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

// Build a NextRequest with a cookie header pre-set.
function requestWithCookie(value: string) {
  return new NextRequest('http://localhost/', {
    headers: { cookie: `${COOKIE_NAME}=${value}` },
  });
}

function emptyRequest() {
  return new NextRequest('http://localhost/');
}

// ─── setOrgCookie ─────────────────────────────────────────────────────────────

describe('setOrgCookie', () => {
  it('sets a signed cookie on the response', () => {
    const res = new NextResponse();
    setOrgCookie(res, 'org-abc');
    const cookie = res.cookies.get(COOKIE_NAME);
    expect(cookie).toBeDefined();
    // Signed format: "<value>.<hmac-hex>"
    expect(cookie!.value).toMatch(/^org-abc\.[a-f0-9]+$/);
  });

  it('produces a different signed value for a different orgId', () => {
    const res1 = new NextResponse();
    const res2 = new NextResponse();
    setOrgCookie(res1, 'org-1');
    setOrgCookie(res2, 'org-2');
    expect(res1.cookies.get(COOKIE_NAME)!.value).not.toBe(
      res2.cookies.get(COOKIE_NAME)!.value,
    );
  });
});

// ─── requireOrgId ─────────────────────────────────────────────────────────────

describe('requireOrgId', () => {
  it('extracts orgId from a valid signed cookie', () => {
    // Sign a cookie value the same way auth.ts does, then feed it in.
    const res = new NextResponse();
    setOrgCookie(res, 'org-xyz');
    const signedValue = res.cookies.get(COOKIE_NAME)!.value;

    const req = requestWithCookie(signedValue);
    const result = requireOrgId(req);
    expect('orgId' in result).toBe(true);
    if ('orgId' in result) expect(result.orgId).toBe('org-xyz');
  });

  it('returns 401 when no cookie is present', () => {
    const result = requireOrgId(emptyRequest());
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('returns 401 when the cookie signature is tampered', () => {
    const req = requestWithCookie('org-evil.deadsignature');
    const result = requireOrgId(req);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('returns 401 when the cookie has no dot separator', () => {
    const result = requireOrgId(requestWithCookie('invalidsigned'));
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('rejects a cookie signed with a different ENCRYPTION_KEY', () => {
    // Sign with key A
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    const res = new NextResponse();
    setOrgCookie(res, 'org-123');
    const signedWithKeyA = res.cookies.get(COOKIE_NAME)!.value;

    // Verify with key B
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    const result = requireOrgId(requestWithCookie(signedWithKeyA));
    expect('error' in result).toBe(true);

    process.env.ENCRYPTION_KEY = TEST_KEY; // restore
  });
});

// ─── clearOrgCookie ───────────────────────────────────────────────────────────

describe('clearOrgCookie', () => {
  it('expires the org cookie so it is effectively cleared', () => {
    const res = new NextResponse();
    setOrgCookie(res, 'org-to-clear');
    expect(res.cookies.get(COOKIE_NAME)!.value).not.toBe('');

    clearOrgCookie(res);

    // Next.js cookies.delete() sets value to '' with a past expiry — not a true Map removal.
    const after = res.cookies.get(COOKIE_NAME);
    const isCleared = after === undefined || after.value === '';
    expect(isCleared).toBe(true);
  });
});

// ─── assertSameOrigin ─────────────────────────────────────────────────────────

describe('assertSameOrigin', () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com';
    // @ts-expect-error NODE_ENV is normally read-only in its type, but tests need to flip it.
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
    // @ts-expect-error see above
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  function requestWithHeaders(headers: Record<string, string>) {
    return new NextRequest('https://app.churnlens.com/api/whatever', { headers });
  }

  it('allows a request whose Origin matches the configured app URL', () => {
    const result = assertSameOrigin(requestWithHeaders({ origin: 'https://app.churnlens.com' }));
    expect(result).toBeNull();
  });

  it('rejects a request from a foreign Origin with a 403', async () => {
    const result = assertSameOrigin(requestWithHeaders({ origin: 'https://evil.example' }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body).toEqual({ error: 'Cross-site request rejected.' });
  });

  it('rejects a request with no Origin header but a cross-site Sec-Fetch-Site', () => {
    const result = assertSameOrigin(requestWithHeaders({ 'sec-fetch-site': 'cross-site' }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('allows a request with no Origin header and no Sec-Fetch-Site header at all', () => {
    const result = assertSameOrigin(requestWithHeaders({}));
    expect(result).toBeNull();
  });

  it('allows a request with no Origin header and Sec-Fetch-Site: same-origin', () => {
    const result = assertSameOrigin(requestWithHeaders({ 'sec-fetch-site': 'same-origin' }));
    expect(result).toBeNull();
  });

  it('allows a request with no Origin header and Sec-Fetch-Site: none (e.g. typed URL)', () => {
    const result = assertSameOrigin(requestWithHeaders({ 'sec-fetch-site': 'none' }));
    expect(result).toBeNull();
  });

  it('rejects Sec-Fetch-Site: same-site — a sibling subdomain is not us', () => {
    const result = assertSameOrigin(requestWithHeaders({ 'sec-fetch-site': 'same-site' }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('outside production, also allows the request origin itself (local dev on a non-default port)', () => {
    // @ts-expect-error NODE_ENV is normally read-only in its type
    process.env.NODE_ENV = 'development';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com'; // deliberately not localhost

    const req = new NextRequest('http://localhost:5000/api/whatever', {
      headers: { origin: 'http://localhost:5000' },
    });
    const result = assertSameOrigin(req);
    expect(result).toBeNull();
  });

  it('in production, does NOT allow the bare request origin when it differs from the app URL', () => {
    const req = new NextRequest('http://localhost:5000/api/whatever', {
      headers: { origin: 'http://localhost:5000' },
    });
    const result = assertSameOrigin(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });
});

// ─── assertSameOrigin: misconfiguration and header precedence ─────────────────
//
// The cases above cover the intended shape of the check. These cover the ways
// it can be undermined: a missing/broken NEXT_PUBLIC_APP_URL (must fail closed,
// not open) and a request that sends BOTH headers with the Origin lying about
// nothing while Sec-Fetch-Site claims same-origin.

describe('assertSameOrigin — misconfiguration and header precedence', () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // @ts-expect-error NODE_ENV is normally read-only in its type, but tests need to flip it.
    process.env.NODE_ENV = 'production';
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
    // @ts-expect-error see above
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('fails closed in production when NEXT_PUBLIC_APP_URL is not set', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const req = new NextRequest('https://app.churnlens.com/api/whatever', {
      headers: { origin: 'https://app.churnlens.com' },
    });
    // No configured origin means there is nothing to match against; rejecting is
    // the safe direction. (A deploy in this state is broken either way — better
    // visibly broken than silently accepting every origin.)
    const result = assertSameOrigin(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('fails closed when NEXT_PUBLIC_APP_URL is not a parseable URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'not a url';
    const result = assertSameOrigin(
      new NextRequest('https://app.churnlens.com/api/whatever', {
        headers: { origin: 'https://app.churnlens.com' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('compares origins, not strings — a configured URL with a path still matches', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com/';
    const result = assertSameOrigin(
      new NextRequest('https://app.churnlens.com/api/whatever', {
        headers: { origin: 'https://app.churnlens.com' },
      }),
    );
    expect(result).toBeNull();
  });

  it('rejects on a foreign Origin even when Sec-Fetch-Site claims same-origin', () => {
    // Origin is the stronger signal and is checked first: a forged
    // Sec-Fetch-Site (only possible from a non-browser client) must not be able
    // to talk its way past a foreign Origin.
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com';
    const result = assertSameOrigin(
      new NextRequest('https://app.churnlens.com/api/whatever', {
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('rejects a scheme/port mismatch on an otherwise identical host', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com';
    for (const origin of ['http://app.churnlens.com', 'https://app.churnlens.com:8443']) {
      const result = assertSameOrigin(
        new NextRequest('https://app.churnlens.com/api/whatever', { headers: { origin } }),
      );
      expect(result, origin).not.toBeNull();
      expect(result!.status).toBe(403);
    }
  });
});
