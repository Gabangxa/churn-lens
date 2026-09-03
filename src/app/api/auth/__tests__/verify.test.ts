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

// ─── The destination rules, exhaustively ─────────────────────────────────────
//
// verify is the only route that mints a session, so where it drops the founder
// and — far more important — WHEN it is willing to set a cookie at all are the
// two behaviours worth pinning down hard.

describe('GET /api/auth/verify — destination rules', () => {
  it('honours a plan carried in redirect_to for a keyless org (growth)', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: '/onboarding?plan=growth' });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: null });

    const res = await GET(verifyRequest('good-token'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding?plan=growth`);
    expect(res.headers.get('set-cookie')).toContain('churnlens_org_id=');
  });

  it.each([['/settings'], ['/dashboard']])(
    'overrides redirect_to %s with /onboarding when the org has no Stripe key',
    async (redirectTo) => {
      queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: redirectTo });
      queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: null });

      const res = await GET(verifyRequest('good-token'));

      // A founder with no key cannot use either page; onboarding wins.
      expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding`);
    },
  );

  it('sends a keyless org to /onboarding even when the org row is missing entirely', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: '/dashboard' });
    queryOneMock.mockResolvedValueOnce(null); // org deleted out from under a live token

    const res = await GET(verifyRequest('good-token'));

    expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding`);
  });
});

describe('GET /api/auth/verify — token handling', () => {
  it('looks the token up by hash, never by its raw value, under a single-use guard', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: null });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: 'v1.encrypted' });

    await GET(verifyRequest('raw-token-value'));

    expect(hashLoginTokenMock).toHaveBeenCalledWith('raw-token-value');
    const [sql, params] = queryOneMock.mock.calls[0];
    expect(params).toEqual(['hashed-token']);
    // Atomic consume-and-check: single-use is enforced by the UPDATE's WHERE
    // clause, not a read-then-write that two concurrent clicks could both pass.
    expect(sql).toMatch(/UPDATE login_tokens SET used_at = now\(\)/);
    expect(sql).toMatch(/used_at IS NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
  });

  it('sets no cookie for a used, expired, or unknown token', async () => {
    queryOneMock.mockResolvedValueOnce(null); // the UPDATE guard matched no row

    const res = await GET(verifyRequest('already-used-token'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=expired`);
    // The failure must not mint a session — this is the one route that can.
    expect(res.headers.get('set-cookie')).toBeNull();
    // And it must not go looking up the org either.
    expect(queryOneMock).toHaveBeenCalledTimes(1);
  });

  it('sets no cookie when no token is supplied at all', async () => {
    const res = await GET(verifyRequest());
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sets the cookie for the token row org, not for anything supplied by the caller', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: 'org-from-token', redirect_to: null });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: 'v1.encrypted' });

    const res = await GET(verifyRequest('good-token'));

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('churnlens_org_id=org-from-token.');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=lax');
  });
});

// verify re-validates redirect_to against the same allow-list
// /api/auth/request wrote it under, rather than trusting the stored value.
// Today request is the only writer and it already allow-lists on the way in,
// so this is defense in depth — but a row this route trusted blindly would be
// one bad migration, admin query, or future writer away from an open redirect
// on the one route that also hands out a session.
describe('GET /api/auth/verify — redirect_to is re-validated, not trusted as stored', () => {
  it('falls back to /dashboard rather than following an off-origin redirect_to', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: 'https://evil.example/' });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: 'v1.encrypted' });

    const res = await GET(verifyRequest('good-token'));

    expect(res.headers.get('location')).toBe(`${APP_URL}/dashboard`);
  });

  it('falls back to /onboarding (not the off-origin value) when the org also has no Stripe key', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: ORG_ID, redirect_to: '//evil.example' });
    queryOneMock.mockResolvedValueOnce({ stripe_api_key_enc: null });

    const res = await GET(verifyRequest('good-token'));

    expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding`);
  });
});
