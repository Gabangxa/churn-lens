import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { queryOne, execute, withTransaction } from '@/lib/db';
import { generateLoginToken } from '@/lib/crypto';
import { getResend, FROM_EMAIL } from '@/lib/resend';
import { checkRateLimit, clientIp } from '@/lib/ratelimit';
import { assertSameOrigin } from '@/lib/auth';

const TOKEN_TTL_MS = 15 * 60 * 1000;

// The only redirect targets a magic link is allowed to carry. Anything else
// (an absolute URL, a protocol-relative "//evil.com", an unlisted path) is an
// open-redirect attempt and is silently dropped rather than rejected, so a
// forged `next` degrades to "no next" instead of failing the whole request.
const ALLOWED_NEXT_PATHS = new Set([
  '/dashboard',
  '/settings',
  '/onboarding',
  '/onboarding?plan=starter',
  '/onboarding?plan=growth',
]);

function sanitizeNext(next: unknown): string | null {
  if (typeof next !== 'string') return null;
  return ALLOWED_NEXT_PATHS.has(next) ? next : null;
}

/**
 * Request a magic-link login email. Doubles as signup: an email with no
 * existing account gets one created (an org + its owner user) before the
 * link is issued, so this is the only door into ChurnLens — there is no
 * separate "create account" endpoint for an attacker to race against a
 * victim's real signup.
 *
 * Enumeration-safe: always responds { ok: true } whether or not the email
 * already had an account, and whether or not the email actually sends.
 * Rate-limited by IP (abuse) and by email (inbox-bombing a victim); an
 * email-rate-limit breach returns immediately, before any account is created
 * or looked up, so it can't be used to force account creation either.
 */
export async function POST(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  const ipRl = checkRateLimit(`login-ip:${clientIp(req)}`, 5, 600_000);
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a minute and try again.' },
      { status: 429, headers: { 'retry-after': String(ipRl.retryAfterSec) } },
    );
  }

  let email: unknown;
  let next: unknown;
  try {
    ({ email, next } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (typeof email !== 'string' || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
  }
  const normEmail = email.trim().toLowerCase();
  const redirectTo = sanitizeNext(next);

  // Per-email throttle. On breach we still return ok (no enumeration) but skip
  // issuing/sending another link — and, now, skip account creation too.
  const emailRl = checkRateLimit(`login-email:${normEmail}`, 5, 900_000);
  if (!emailRl.allowed) {
    return NextResponse.json({ ok: true });
  }

  // Opportunistic cleanup so the table doesn't accumulate dead tokens.
  await execute(`DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'`);

  // users.email has a unique index on lower(email) (see scripts/migrate.js),
  // so this is at most one row.
  const existingUser = await queryOne<{ org_id: string }>(
    'SELECT org_id FROM users WHERE lower(email) = $1',
    [normEmail],
  );

  let orgId: string;
  if (existingUser) {
    orgId = existingUser.org_id;
  } else {
    // Signup path. The org and its owner user are created in one transaction
    // so a mid-way failure can never leave an org with no user (unreachable —
    // nothing queries users by org and finds nothing, but the digest cron
    // would silently have no one to send to) or, worse, a user row pointing at
    // an org that doesn't exist.
    orgId = await withTransaction(async (client) => {
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING id`,
        [randomUUID(), 'My Organization'],
      );
      const newOrgId = orgResult.rows[0].id;
      await client.query(
        `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner')`,
        [newOrgId, normEmail],
      );
      return newOrgId;
    });
  }

  const { token, tokenHash } = generateLoginToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  await execute(
    `INSERT INTO login_tokens (token_hash, org_id, email, expires_at, redirect_to)
     VALUES ($1, $2, $3, $4, $5)`,
    [tokenHash, orgId, normEmail, expiresAt, redirectTo],
  );

  const loginUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/verify?token=${token}`;

  try {
    // Resend resolves with `{ data: null, error }` rather than throwing, so
    // the catch below only sees failures if we surface them ourselves.
    // Without this, a rejected send is logged as a delivered login link.
    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to: normEmail,
      subject: 'Your ChurnLens login link',
      text: `Hi,

Here's your ChurnLens login link:

→ ${loginUrl}

This link signs you in — or, if this is your first time, finishes creating
your account. It's valid for 15 minutes and can only be used once. If you
didn't request this, you can safely ignore this email — nothing will happen.

— ChurnLens`,
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
    }
  } catch (err) {
    // Log but don't leak send status to the caller.
    console.error('Login email send failed:', err);
  }

  return NextResponse.json({ ok: true });
}
