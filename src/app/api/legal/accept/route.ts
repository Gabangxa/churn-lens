import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { assertSameOrigin, requireOrgId, clearOrgCookie } from '@/lib/auth';
import { LEGAL_DOCS_VERSION } from '@/lib/legal-version';

/**
 * Records the signed-in org's acceptance of the current Terms of Service and
 * Data Processing Agreement — the dashboard banner's "I agree".
 *
 * New orgs accept at connect (/api/onboarding/connect). This route covers
 * everyone else: the orgs that connected before acceptance was recorded at
 * all, and every org after LEGAL_DOCS_VERSION is bumped. It records and
 * nothing more — no feature is gated on acceptance here or anywhere else yet,
 * pending legal advice on whether to.
 *
 * Same-origin and session checks first, like every state-changing route: a
 * third-party page must not be able to agree to anything on a signed-in
 * founder's behalf.
 */
export async function POST(req: NextRequest) {
  const csrfError = assertSameOrigin(req);
  if (csrfError) return csrfError;

  // Awaited: the session gate checks the database (expiry, sign-out
  // everywhere, a purged org). Un-awaited, `'error' in auth` is asked of a
  // Promise, is always false, and every request would get past this line.
  const auth = await requireOrgId(req);
  if ('error' in auth) return auth.error;
  const { orgId } = auth;

  let acceptedLegalVersion: unknown;
  try {
    ({ acceptedLegalVersion } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  // The banner sends the version it was rendered with. One rendered before a
  // version bump showed links to documents that have since changed, so it is
  // told to reload rather than recorded as agreeing to the new text.
  if (acceptedLegalVersion !== LEGAL_DOCS_VERSION) {
    const error =
      typeof acceptedLegalVersion === 'string' && acceptedLegalVersion !== ''
        ? 'The Terms of Service or Data Processing Agreement changed after this page loaded. Reload the page to review and accept the current version.'
        : 'Accepting requires the current version of the Terms of Service and Data Processing Agreement.';
    return NextResponse.json({ error }, { status: 400 });
  }

  try {
    // Idempotent: re-accepting the version already on record keeps the
    // original time, so a double click or a second tab cannot move the record
    // of when the founder agreed to this wording. In a SET clause the
    // right-hand columns are the row's values BEFORE this update, and the
    // organizations_legal_acceptance_pair_check constraint guarantees a
    // matching version always has a time beside it. now() is the database's
    // clock, never anything the client sent. /api/onboarding/connect applies
    // the same rule.
    const org = await queryOne<{ legal_accepted_at: Date; legal_accepted_version: string }>(
      `UPDATE organizations
       SET legal_accepted_at = CASE WHEN legal_accepted_version = $1 THEN legal_accepted_at ELSE now() END,
           legal_accepted_version = $1
       WHERE id = $2
       RETURNING legal_accepted_at, legal_accepted_version`,
      [LEGAL_DOCS_VERSION, orgId],
    );

    if (!org) {
      // requireOrgId already refuses a session whose org row is gone, so this
      // is only reachable if the org was deleted between that check and this
      // write. Nothing to record against; evict the dead session, as
      // /api/onboarding/connect does.
      const response = NextResponse.json(
        { error: 'Session is no longer valid. Please log in again.' },
        { status: 401 },
      );
      return clearOrgCookie(response);
    }

    return NextResponse.json({
      ok: true,
      version: org.legal_accepted_version,
      acceptedAt: new Date(org.legal_accepted_at).toISOString(),
    });
  } catch (err) {
    console.error(`Recording legal acceptance failed for org ${orgId}:`, err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
