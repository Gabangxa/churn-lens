import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const hashLoginTokenMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  hashLoginToken: (...args: unknown[]) => hashLoginTokenMock(...args),
}));

import { GET } from '../verify/route';

const ORG_ID = 'org-abc';
const APP_URL = 'https://app.churnlens.com';
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function verifyRequest(token?: string) {
  const url = token ? `http://localhost/api/auth/verify?token=${token}` : 'http://localhost/api/auth/verify';
  return new NextRequest(url);
}

beforeEach(() => {
  queryOneMock.mockReset();
  hashLoginTokenMock.mockReset().mockReturnValue('hashed-token');
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  // setOrgCookie (real, unmocked — this route is the one place it's allowed
  // to run for real) signs the cookie with this key.
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('GET /api/auth/verify', () => {
  it('redirects to /login?error=expired when no token is supplied', async () => {
    const res = await GET(verifyRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('redirects to /login?error=expired for an invalid, expired, or already-used token', async () => {
    // The atomic UPDATE...RETURNING guard finds no row for any of these cases.
    queryOneMock.mockResolvedValueOnce(null);
    const res = await GET(verifyRequest('bad-token'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
  });

  it('sends an org with no Stripe key yet to /onboarding', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: null }); // token consume
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: null }); // org lookup

    const res = await GET(verifyRequest('good-token'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding`);
    expect(res.headers.get('set-cookie')).toContain('churnlens_org_id=');
  });

  it('preserves a plan carried in redirect_to for a keyless org', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: '/onboarding?plan=starter' });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: null });

    const res = await GET(verifyRequest('good-token'));

    expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding?plan=starter`);
  });

  it('sends an org that has a Stripe key to its stored redirect_to', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: '/settings' });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: 'v1.encrypted' });

    const res = await GET(verifyRequest('good-token'));

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings`);
    expect(res.headers.get('set-cookie')).toContain('churnlens_org_id=');
  });

  it('defaults a connected org with no stored redirect_to to /dashboard', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: null });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: 'v1.encrypted' });

    const res = await GET(verifyRequest('good-token'));

    expect(res.headers.get('location')).toBe(`${APP_URL}/dashboard`);
  });
});
