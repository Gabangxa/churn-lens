import { NextRequest, NextResponse } from 'next/server';
import { queryOne, execute } from '@/lib/db';
import { generateLoginToken } from '@/lib/crypto';
import { resend, FROM_EMAIL } from '@/lib/resend';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';

const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Request a magic-link login email.
 *
 * Enumeration-safe: always responds { ok: true } whether or not the email maps
 * to an account, and whether or not the email actually sends. Rate-limited by IP
 * (abuse) and by email (inbox-bombing a victim).
 */
export async function POST(req: NextRequest) {
  const ipRl = checkRateLimit(`login-ip:${clientIp(req)}`, 5, 600_000);
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a minute and try again.' },
      { status: 429, headers: { 'retry-after': String(ipRl.retryAfterSec) } },
    );
  }

  let email: unknown;
  try {
    ({ email } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (typeof email !== 'string' || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
  }
  const normEmail = email.trim().toLowerCase();

  // Per-email throttle. On breach we still return ok (no enumeration) but skip
  // issuing/sending another link.
  const emailRl = checkRateLimit(`login-email:${normEmail}`, 5, 900_000);
  if (!emailRl.allowed) {
    return NextResponse.json({ ok: true });
  }

  // Opportunistic cleanup so the table doesn't accumulate dead tokens.
  await execute(`DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'`);

  const user = await queryOne<{ org_id: string }>(
    'SELECT org_id FROM users WHERE lower(email) = $1 ORDER BY created_at DESC LIMIT 1',
    [normEmail],
  );

  if (user) {
    const { token, tokenHash } = generateLoginToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    await execute(
      `INSERT INTO login_tokens (token_hash, org_id, email, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash, user.org_id, normEmail, expiresAt],
    );

    const loginUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/verify?token=${token}`;

    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: normEmail,
        subject: 'Your ChurnLens login link',
        text: `Hi,

Here's your login link for ChurnLens:

→ ${loginUrl}

It's valid for 15 minutes and can only be used once. If you didn't request
this, you can safely ignore this email — nothing will happen.

— ChurnLens`,
      });
    } catch (err) {
      // Log but don't leak send status to the caller.
      console.error('Login email send failed:', err);
    }
  }

  return NextResponse.json({ ok: true });
}
