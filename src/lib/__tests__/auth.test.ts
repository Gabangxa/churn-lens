import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createHmac, hkdfSync } from 'crypto';
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Mint a session cookie value exactly as /api/auth/verify does, as of `at`. */
function mintCookie(orgId: string, at: Date = new Date()): string {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  try {
    const res = new NextResponse();
    setOrgCookie(res, orgId);
    return res.cookies.get(COOKIE_NAME)!.value;
  } finally {
    vi.useRealTimers();
  }
}

/** Run `fn` with the clock reading `at` — for "how does this cookie look later". */
function at<T>(when: Date, fn: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(when);
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

// ─── setOrgCookie ─────────────────────────────────────────────────────────────

describe('setOrgCookie', () => {
  it('sets a signed cookie carrying the org id and the moment it was issued', () => {
    const issuedAt = new Date('2026-09-01T12:00:00.000Z');
    const value = mintCookie('org-abc', issuedAt);
    // "<orgId>.<issuedAtMs>.<hmac-hex>" — the issued-at is inside the signed
    // part, so the server can enforce expiry without trusting the browser.
    expect(value).toBe(`org-abc.${issuedAt.getTime()}.${value.split('.')[2]}`);
    expect(value.split('.')[2]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('asks the browser to keep the cookie for 30 days, the same as the server-side limit', () => {
    const res = new NextResponse();
    setOrgCookie(res, 'org-abc');
    expect(res.headers.get('set-cookie')).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
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
    // A genuine cookie with one signature nibble flipped: right shape, right
    // length, so only the HMAC comparison itself can turn it away.
    const [orgId, issuedAt, signature] = mintCookie('org-xyz').split('.');
    const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
    const result = requireOrgId(requestWithCookie(`${orgId}.${issuedAt}.${flipped}`));
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('returns 401 for a cookie that is not in the signed format at all', () => {
    const result = requireOrgId(requestWithCookie('org-evil.deadsignature'));
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('returns 401 when the cookie has no dot separator', () => {
    const result = requireOrgId(requestWithCookie('invalidsigned'));
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('rejects a cookie HMACed directly with ENCRYPTION_KEY — the session key is derived, not the raw secret', () => {
    // Exactly what the pre-HKDF build minted: HMAC-SHA256 keyed with the very
    // secret that encrypts customers' Stripe keys. A cookie in this shape must
    // not authenticate, or the key separation is decorative.
    const rawKeyHmac = createHmac('sha256', TEST_KEY).update('org-xyz').digest('hex');
    const result = requireOrgId(requestWithCookie(`org-xyz.${rawKeyHmac}`));
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

// ─── requireOrgId: expiry ─────────────────────────────────────────────────────
//
// Cookie Max-Age is advice to an honest browser. A copied cookie value replayed
// by hand carries no expiry at all, so the 30 days are enforced from the signed
// issued-at, on the server.

describe('requireOrgId — sessions expire 30 days after issue', () => {
  const ISSUED = new Date('2026-09-01T12:00:00.000Z');

  it('accepts a session up to the last millisecond of its 30 days', () => {
    const value = mintCookie('org-xyz', ISSUED);
    const result = at(new Date(ISSUED.getTime() + 30 * DAY_MS - 1), () =>
      requireOrgId(requestWithCookie(value)),
    );
    expect(result).toEqual({ orgId: 'org-xyz' });
  });

  it('rejects the same session once 30 days have passed, whatever the browser still holds', () => {
    const value = mintCookie('org-xyz', ISSUED);
    const result = at(new Date(ISSUED.getTime() + 30 * DAY_MS), () =>
      requireOrgId(requestWithCookie(value)),
    );
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('rejects a session whose issued-at was rewritten to extend it — the timestamp is signed', () => {
    const value = mintCookie('org-xyz', ISSUED);
    const [orgId, , signature] = value.split('.');
    const now = new Date(ISSUED.getTime() + 31 * DAY_MS);
    const extended = `${orgId}.${now.getTime()}.${signature}`;

    const result = at(now, () => requireOrgId(requestWithCookie(extended)));
    expect('error' in result).toBe(true);
  });

  it('rejects a correctly keyed cookie that carries no issued-at at all', () => {
    // The shape a session would have if issued-at were ever made optional:
    // signed with the right key, but with nothing to expire it by. A sanity
    // mint with the same local derivation first proves the forgery below is
    // keyed correctly, so its rejection is about the missing timestamp and not
    // about a stale label in this test.
    const sessionKey = Buffer.from(
      hkdfSync('sha256', TEST_KEY, '', 'churnlens/session-cookie/v1', 32),
    );
    const hmacHex = (payload: string) => createHmac('sha256', sessionKey).update(payload).digest('hex');

    const issuedAtMs = Date.now();
    const sanity = requireOrgId(
      requestWithCookie(`org-xyz.${issuedAtMs}.${hmacHex(`org-xyz.${issuedAtMs}`)}`),
    );
    expect(sanity).toEqual({ orgId: 'org-xyz' });

    const result = requireOrgId(requestWithCookie(`org-xyz.${hmacHex('org-xyz')}`));
    expect('error' in result).toBe(true);
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
