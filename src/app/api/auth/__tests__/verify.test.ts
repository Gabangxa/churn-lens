import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The parts of /api/auth/verify that must not touch the database at all.
 *
 * The database is stubbed to fail every call, so any test here that passes
 * proves the path never reached it — opening the emailed link is inert, and a
 * forged cross-site POST is turned away before the token is even looked up.
 * Everything that does reach the database (consuming the token, where the
 * founder lands, the confirm page) runs against real Postgres in
 * verify.db.test.ts.
 */
const databaseCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/db', () => {
  const refuse = async () => {
    databaseCalls.count += 1;
    throw new Error('this path must not touch the database');
  };
  return { query: refuse, queryOne: refuse, execute: refuse };
});

import * as route from '../verify/route';
import { GET, POST } from '../verify/route';
import { metadata as confirmPageMetadata } from '@/app/login/confirm/page';

const APP_URL = 'https://app.churnlens.com';

beforeEach(() => {
  databaseCalls.count = 0;
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
  vi.stubEnv('ENCRYPTION_KEY', 'b'.repeat(64));
});

describe('GET /api/auth/verify — the link in the email', () => {
  it('forwards to the confirm page, carrying the token, and does nothing else', async () => {
    const res = await GET(new NextRequest('http://localhost/api/auth/verify?token=abc_DEF-123'));

    // 303 so the browser follows with a GET whatever method it arrived with.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login/confirm?token=abc_DEF-123`);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(databaseCalls.count).toBe(0);
  });

  it('URL-encodes whatever it was given rather than splicing it into the redirect', async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/auth/verify?token=${encodeURIComponent('a&next=//evil.example')}`),
    );

    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe(APP_URL);
    expect(location.pathname).toBe('/login/confirm');
    expect(Array.from(location.searchParams.keys())).toEqual(['token']);
    expect(location.searchParams.get('token')).toBe('a&next=//evil.example');
  });

  it('sends a link with no token to the /login error', async () => {
    const res = await GET(new NextRequest('http://localhost/api/auth/verify'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
    expect(databaseCalls.count).toBe(0);
  });

  it('exports no HEAD of its own — Next answers HEAD with this same inert GET', () => {
    // Link scanners often HEAD a URL before (or instead of) fetching it.
    // Next implements HEAD from GET when a route does not export one; a HEAD
    // export added here later would have to be just as side-effect free.
    expect(Object.keys(route).sort()).toEqual(['GET', 'POST']);
  });
});

describe('POST /api/auth/verify — refused before the token is looked up', () => {
  function forgedPost(headers: Record<string, string>) {
    return POST(
      new NextRequest('http://localhost/api/auth/verify', {
        method: 'POST',
        headers,
        body: new URLSearchParams({ token: 'attacker-token' }),
      }),
    );
  }

  it('rejects a foreign Origin with 403', async () => {
    const res = await forgedPost({ origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(databaseCalls.count).toBe(0);
  });

  it('rejects Sec-Fetch-Site: cross-site when no Origin is sent', async () => {
    const res = await forgedPost({ 'sec-fetch-site': 'cross-site' });

    expect(res.status).toBe(403);
    expect(databaseCalls.count).toBe(0);
  });

  it('rejects Origin: null (a sandboxed frame or a data: URL page)', async () => {
    const res = await forgedPost({ origin: 'null' });

    expect(res.status).toBe(403);
    expect(databaseCalls.count).toBe(0);
  });
});

describe('/login/confirm — the page whose form is the only way to POST here', () => {
  it('keeps its token out of Referer without making the browser send Origin: null', () => {
    // Browsers serialize the Origin of a POST as "null" when the page's
    // referrer policy is no-referrer, and assertSameOrigin above refuses
    // "null" — so that policy made the confirm button a 403 for everyone.
    // strict-origin never sends the path or query (where the token is) as
    // Referer, and leaves Origin intact for a same-origin POST.
    expect(confirmPageMetadata.referrer).toBe('strict-origin');
  });
});
