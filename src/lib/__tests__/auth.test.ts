import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { setOrgCookie, requireOrgId, clearOrgCookie } from '../auth';

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
