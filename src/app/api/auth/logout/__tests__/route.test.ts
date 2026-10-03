import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Only the database is stubbed — auth (assertSameOrigin, the session check,
// the revocation) is real throughout. The happy path of logging out
// everywhere runs against a real Postgres in src/lib/__tests__/auth.db.test.ts;
// this file needs the database only to make it fail on demand.
const queryOneMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

import * as route from '../route';
import { POST } from '../route';
import { setOrgCookie } from '@/lib/auth';
// Real: these tests assert on what the route reported. ALERT_EMAIL is pinned
// empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function logoutRequest() {
  return new NextRequest('http://localhost/api/auth/logout', { method: 'POST' });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com';
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
  queryOneMock.mockReset().mockResolvedValue({ sessions_valid_after: null });
  executeMock.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('POST /api/auth/logout', () => {
  it('clears the org session cookie', async () => {
    const res = await POST(logoutRequest());

    // next/server serializes a delete as Max-Age=0 on the Set-Cookie header.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('org_id=');
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  it('redirects to the landing page with 303 so the browser follows with GET', async () => {
    const res = await POST(logoutRequest());

    // 307 would replay the POST against the landing page; 303 must not.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.churnlens.com/');
  });

  it('is not reachable by GET — a bare GET must not be able to log a user out', () => {
    // The CSRF fix: no GET export means Next returns 405 for a link, an
    // <img src>, or a prefetch pointing at this route.
    expect('GET' in route).toBe(false);
    expect(Object.keys(route)).toEqual(['POST']);
  });
});

// The real assertSameOrigin runs here (this file mocks nothing), so these
// exercise the actual header check, not a stub of it.
describe('POST /api/auth/logout — cross-site rejection', () => {
  it('rejects a foreign Origin with 403 and clears nothing', async () => {
    const req = new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    // A drive-by logout is an annoyance, not a breach — but the guard being
    // present here is what proves it is wired on every mutating route.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
  });

  it('rejects a cross-site form post that carries no Origin but does carry Sec-Fetch-Site', async () => {
    const req = new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('allows a same-origin post and still logs the user out', async () => {
    const req = new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    });

    const res = await POST(req);

    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

// ─── Signing out everywhere, when the database will not cooperate ────────────

describe('POST /api/auth/logout — when sessions cannot be revoked server-side', () => {
  function sessionCookie(orgId = '11111111-1111-4111-8111-111111111111'): string {
    const carrier = new NextResponse();
    setOrgCookie(carrier, orgId);
    return carrier.cookies.get('churnlens_org_id')!.value;
  }

  function logoutWithSession() {
    return new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `churnlens_org_id=${sessionCookie()}` },
    });
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still signs this browser out, but sends it to a page that says the other devices were not', async () => {
    resetErrorReports();
    executeMock.mockRejectedValue(new Error('connection terminated'));

    const res = await POST(logoutWithSession());

    // A founder logging out because a laptop went missing must not be shown
    // the landing page as if every device had been signed out. Nor a raw
    // JSON error page: the logout button is a native form POST, so whatever
    // this answers is what the browser shows. /login says what happened and
    // is where the fix (sign in, log out again) starts.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.churnlens.com/login?error=logout_partial');
    // This browser's cookie goes regardless — that part never needed the DB.
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(console.error).toHaveBeenCalled();
    // Reported with the org whose other sessions are still live.
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'auth.logout',
        message: 'connection terminated',
        meta: { orgId: '11111111-1111-4111-8111-111111111111' },
      }),
    ]);
  });

  it('treats a failed session lookup the same way — it cannot tell whether anything was revoked', async () => {
    resetErrorReports();
    queryOneMock.mockRejectedValue(new Error('connection refused'));

    const res = await POST(logoutWithSession());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.churnlens.com/login?error=logout_partial');
    // No org id: the session was never confirmed, so none is claimed.
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'auth.logout', message: 'connection refused', meta: {} }),
    ]);
    expect(executeMock).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  it('touches no database at all when there is no session to end', async () => {
    const res = await POST(logoutRequest());

    expect(res.status).toBe(303);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });
});
