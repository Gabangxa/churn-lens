import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import * as route from '../route';
import { POST } from '../route';

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function logoutRequest() {
  return new NextRequest('http://localhost/api/auth/logout', { method: 'POST' });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com';
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
