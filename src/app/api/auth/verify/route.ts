import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { hashLoginToken } from '@/lib/crypto';
import { setOrgCookie } from '@/lib/auth';

/**
 * Consume a magic-link token and establish the session.
 *
 * Single-use is enforced atomically by the UPDATE guard (used_at IS NULL) rather
 * than a check-then-act, so a replayed or concurrent second click can't log in.
 * On any failure (missing/invalid/expired/already-used) we redirect to /login
 * with a generic error rather than distinguishing cases.
 */
export async function GET(req: NextRequest) {
  const fail = () =>
    NextResponse.redirect(new URL('/login?error=expired', req.url), { status: 303 });

  const token = req.nextUrl.searchParams.get('token');
  if (!token) return fail();

  const row = await queryOne<{ org_id: string }>(
    `UPDATE login_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING org_id`,
    [hashLoginToken(token)],
  );

  if (!row) return fail();

  const response = NextResponse.redirect(new URL('/dashboard', req.url), { status: 303 });
  return setOrgCookie(response, row.org_id);
}
