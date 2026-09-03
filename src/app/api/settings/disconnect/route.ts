import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { assertSameOrigin, requireOrgId } from '@/lib/auth';
import { redirectUrl } from '@/lib/app-url';
import { disconnectStripe } from '@/lib/stripe-disconnect';

export async function DELETE(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  const auth = requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  const org = await queryOne<{ id: string }>(
    'SELECT id FROM organizations WHERE id = $1',
    [orgId],
  );

  if (!org) {
    return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
  }

  // Shared with the purge job's hard-delete-on-account-deletion path — see
  // src/lib/stripe-disconnect.ts.
  await disconnectStripe(orgId);

  // Disconnecting Stripe is not logging out — the session survives, unlike the
  // old behavior which cleared the cookie here. Sessions are minted only by
  // /api/auth/verify now, so there is nothing to re-derive from a login-less
  // reconnect; clearing the cookie would just force a pointless re-login.
  //
  // redirectUrl (not a hand-built template string): NextResponse.redirect
  // requires an absolute URL, and `${appUrl}/onboarding` is '/onboarding' when
  // NEXT_PUBLIC_APP_URL is unset — a relative "URL" that throws here, AFTER the
  // key has already been nulled above. redirectUrl falls back to req.url so
  // this can never throw on a misconfigured deploy.
  return NextResponse.redirect(redirectUrl('/onboarding', req), { status: 303 });
}
