import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

const ORG_COOKIE = 'churnlens_org_id';

function getSigningKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY not set');
  return key;
}

function sign(value: string): string {
  const hmac = createHmac('sha256', getSigningKey()).update(value).digest('hex');
  return `${value}.${hmac}`;
}

function verify(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.substring(0, idx);
  const expected = sign(value);
  const expectedBuf = Buffer.from(expected);
  const signedBuf = Buffer.from(signed);
  if (expectedBuf.length !== signedBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, signedBuf)) return null;
  return value;
}

export function setOrgCookie(response: NextResponse, orgId: string): NextResponse {
  response.cookies.set(ORG_COOKIE, sign(orgId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

export function clearOrgCookie(response: NextResponse): NextResponse {
  response.cookies.delete(ORG_COOKIE);
  return response;
}

/**
 * For use in server components. Pass the return value of `cookies()` from
 * `next/headers`. Returns the verified orgId or null if missing/invalid.
 *
 * Example:
 *   import { cookies } from 'next/headers';
 *   const orgId = getOrgIdFromCookieStore(cookies());
 */
export function getOrgIdFromCookieStore(
  cookieStore: { get(name: string): { value: string } | undefined },
): string | null {
  const raw = cookieStore.get(ORG_COOKIE)?.value;
  if (!raw) return null;
  return verify(raw);
}

export function requireOrgId(req: NextRequest): { orgId: string } | { error: NextResponse } {
  const raw = req.cookies.get(ORG_COOKIE)?.value;
  if (!raw) {
    return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) };
  }
  const orgId = verify(raw);
  if (!orgId) {
    return { error: NextResponse.json({ error: 'Invalid session.' }, { status: 401 }) };
  }
  return { orgId };
}
