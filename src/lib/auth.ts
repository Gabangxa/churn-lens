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

/**
 * Rejects cross-site requests to a state-changing route (login CSRF, and
 * generally, session-riding requests).
 *
 * SameSite=Lax on the org cookie already blocks cross-site *simple* form posts
 * from carrying the cookie, but it does not stop a foreign page's fetch() (no
 * credentials needed for auth/request, which sets no cookie on the attacker's
 * behalf but can still mint tokens/spend rate-limit budget against a victim's
 * inbox) or a same-site-cookie-bearing request issued via something Lax does
 * allow (top-level navigation). Checking Origin/Sec-Fetch-Site directly is the
 * standard defense and does not depend on cookie semantics at all.
 *
 * Preferred signal is the `Origin` header, sent by browsers on every
 * state-changing fetch/XHR and on cross-origin navigations. When it is
 * present, it must exactly match the app's own origin (or, outside
 * production, the request's own origin — so local dev on a non-default port
 * still works without needing NEXT_PUBLIC_APP_URL set to match it exactly).
 *
 * Some requests carry no Origin header at all (same-origin GETs, and some
 * older/simple requests) — for those we fall back to `Sec-Fetch-Site`, which
 * every modern browser attaches. `same-origin` and `none` (e.g. a user typing
 * the URL directly, or a bookmark) are allowed; anything else (`cross-site`,
 * `same-site`) is rejected. A request with neither header is allowed through,
 * since that combination only occurs from very old browsers we cannot
 * evaluate — rejecting them would break real users for a theoretical gain
 * against attackers who, lacking both headers, are almost certainly not a
 * browser we need to worry about anyway.
 *
 * Call this FIRST in a route handler, before any other work — the whole point
 * is to refuse a forged request before it can do (or even schedule) anything.
 */
// Logged at most once per process: a broken NEXT_PUBLIC_APP_URL is a deploy
// misconfiguration, not a per-request event, and this route is hit on every
// page load — without the flag a single bad deploy would spam the log at
// request volume instead of saying it once.
let warnedNoAllowedOriginsInProduction = false;

export function assertSameOrigin(req: NextRequest): NextResponse | null {
  const origin = req.headers.get('origin');

  const allowedOrigins = new Set<string>();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      allowedOrigins.add(new URL(appUrl).origin);
    } catch {
      // Misconfigured NEXT_PUBLIC_APP_URL. Nothing to add — an Origin header
      // present on the request will simply fail to match below, which is the
      // safe direction to fail in (reject rather than silently allow).
      console.error(`assertSameOrigin: NEXT_PUBLIC_APP_URL "${appUrl}" is not a valid URL.`);
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add(req.nextUrl.origin);
  }

  if (allowedOrigins.size === 0 && process.env.NODE_ENV === 'production' && !warnedNoAllowedOriginsInProduction) {
    warnedNoAllowedOriginsInProduction = true;
    console.error(
      'assertSameOrigin: NEXT_PUBLIC_APP_URL is missing or invalid in production — every request that carries an Origin or Sec-Fetch-Site header will be rejected until it is set.',
    );
  }

  if (origin) {
    if (!allowedOrigins.has(origin)) {
      return NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 });
    }
    return null;
  }

  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 });
  }

  return null;
}

/**
 * Constant-time check of the internal cron bearer token, so the CRON_SECRET
 * can't be recovered via response-timing. Used by the /api/themes and
 * /api/digest cron endpoints.
 */
export function verifyCronSecret(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
