import { NextRequest, NextResponse } from 'next/server';
import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';

const ORG_COOKIE = 'churnlens_org_id';

/**
 * HKDF `info` label for the session-cookie HMAC key. Changing it changes the
 * derived key, which invalidates every outstanding session at once — so it is
 * also the lever for any future change to the cookie's signed format.
 */
const SESSION_KEY_INFO = 'churnlens/session-cookie/v1';

/**
 * The session HMAC key, derived from ENCRYPTION_KEY rather than being it.
 *
 * ENCRYPTION_KEY also encrypts every customer's Stripe restricted key
 * (src/lib/crypto.ts). Keying the cookie HMAC with that same secret meant the
 * one value whose compromise exposes every connected Stripe account was also
 * fed, raw, into a second primitive on every request — and that any future
 * change to session signing had to be reasoned about against AES-GCM too.
 *
 * Why a derived key is enough, and no separate SESSION_SECRET is needed:
 * HKDF-SHA256 with a distinct `info` label yields a key that is
 * computationally independent of ENCRYPTION_KEY and of anything else derived
 * from it under another label. Knowing (or brute-forcing a cookie toward) the
 * session key reveals nothing about ENCRYPTION_KEY, because HKDF is one-way.
 * What a second env var would add is independent rotation — and that is
 * already covered without one: bumping SESSION_KEY_INFO logs everyone out
 * without touching the Stripe-key ciphertext. One fewer secret to provision,
 * store and lose is the better trade.
 *
 * The IKM is the configured string as-is (no hex decode): HKDF's extract step
 * condenses any input keying material, so this does not need to re-implement
 * or depend on crypto.ts's parsing. The salt is empty because the IKM is
 * already a uniformly random 256-bit secret (validateEnv enforces 64 hex
 * chars), which is the case RFC 5869 §3.1 says needs no salt.
 *
 * Re-derived per call rather than cached: it is two HMAC computations, and a
 * cache would have to notice ENCRYPTION_KEY changing (tests swap it) to stay
 * correct.
 */
function getSessionSigningKey(): Buffer {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY not set');
  return Buffer.from(hkdfSync('sha256', encryptionKey, '', SESSION_KEY_INFO, 32));
}

/**
 * Hard lifetime of a session, counted from the moment /api/auth/verify issued
 * it. Not refreshed on use: a founder who is active every day still re-proves
 * inbox ownership once a month, and a stolen cookie is worthless after at most
 * this long, however busy the account is.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Session cookie wire format:
 *
 *   <orgId>.<issuedAtMs>.<hex HMAC-SHA256 of the string "<orgId>.<issuedAtMs>">
 *
 * The issued-at lives inside the signed part so the SERVER decides when a
 * session ends. Cookie Max-Age is only advice to an honest browser; a cookie
 * value copied out of one and replayed by hand carries no expiry at all.
 *
 * orgId is always an organizations.id uuid, so it never contains the '.'
 * separator, and a well-formed value is exactly three parts. That rule alone
 * rejects the pre-expiry `<orgId>.<hmac>` cookies still sitting in browsers,
 * before any key is even involved.
 */
interface SessionClaims {
  orgId: string;
  issuedAtMs: number;
}

function sessionHmac(payload: string): Buffer {
  return createHmac('sha256', getSessionSigningKey()).update(payload).digest();
}

function encodeSession({ orgId, issuedAtMs }: SessionClaims): string {
  const payload = `${orgId}.${issuedAtMs}`;
  return `${payload}.${sessionHmac(payload).toString('hex')}`;
}

/** Returns the signed claims, or null if the value is malformed or forged. Says nothing about expiry. */
function decodeSession(cookieValue: string): SessionClaims | null {
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [orgId, issuedAtText, signatureHex] = parts;
  // Shape checks first, so the comparison below always sees two 32-byte
  // buffers. The 15-digit cap keeps Number() exact (Date.now() is 13 digits).
  if (!orgId || !/^\d{1,15}$/.test(issuedAtText) || !/^[0-9a-f]{64}$/.test(signatureHex)) {
    return null;
  }
  const expected = sessionHmac(`${orgId}.${issuedAtText}`);
  const provided = Buffer.from(signatureHex, 'hex');
  // Constant-time: an early-exit compare would tell an attacker how many
  // leading bytes of a forged signature are right, one request at a time.
  if (!timingSafeEqual(expected, provided)) return null;
  return { orgId, issuedAtMs: Number(issuedAtText) };
}

/** The orgId of a genuine, unexpired session cookie, or null. */
function verifySession(cookieValue: string): string | null {
  const claims = decodeSession(cookieValue);
  if (!claims) return null;
  if (Date.now() - claims.issuedAtMs >= SESSION_TTL_MS) return null;
  return claims.orgId;
}

export function setOrgCookie(response: NextResponse, orgId: string): NextResponse {
  response.cookies.set(ORG_COOKIE, encodeSession({ orgId, issuedAtMs: Date.now() }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // Matches the server-side limit so the browser drops the cookie when it
    // stops working anyway. Enforcement is verifySession, not this.
    maxAge: SESSION_TTL_MS / 1000,
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
  return verifySession(raw);
}

export function requireOrgId(req: NextRequest): { orgId: string } | { error: NextResponse } {
  const raw = req.cookies.get(ORG_COOKIE)?.value;
  if (!raw) {
    return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) };
  }
  const orgId = verifySession(raw);
  if (!orgId) {
    return { error: NextResponse.json({ error: 'Invalid session.' }, { status: 401 }) };
  }
  return { orgId };
}

// Logged at most once per process: a broken NEXT_PUBLIC_APP_URL is a deploy
// misconfiguration, not a per-request event, and this route is hit on every
// page load — without the flag a single bad deploy would spam the log at
// request volume instead of saying it once.
let warnedNoAllowedOriginsInProduction = false;

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
