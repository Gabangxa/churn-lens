import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { assertSameOrigin, requireOrgId, clearOrgCookie } from '@/lib/auth';
import { currentLegalDocsVersion } from '@/lib/legal-version';
import { recordLegalAcceptance } from '@/lib/legal-acceptance';
import { reportError } from '@/lib/report-error';
import { withErrorReporting } from '@/lib/with-error-reporting';

/**
 * Records the signed-in org's acceptance of the current Terms of Service and
 * Data Processing Agreement — the dashboard banner's "I agree".
 *
 * New orgs accept at connect (/api/onboarding/connect). This route covers
 * everyone else: the orgs that connected before acceptance was recorded at
 * all, and every org after the current version changes (a LEGAL_DOCS_VERSION
 * bump, or legal.ts losing its placeholders). It records and
 * nothing more — no feature is gated on acceptance here or anywhere else yet,
 * pending legal advice on whether to.
 *
 * Same-origin and session checks first, like every state-changing route: a
 * third-party page must not be able to agree to anything on a signed-in
 * founder's behalf.
 */
async function acceptLegalDocs(req: NextRequest) {
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
  // version change showed links to documents that have since changed, so it is
  // told to reload rather than recorded as agreeing to the new text.
  const currentVersion = currentLegalDocsVersion();
  if (acceptedLegalVersion !== currentVersion) {
    const error =
      typeof acceptedLegalVersion === 'string' && acceptedLegalVersion !== ''
        ? 'The Terms of Service or Data Processing Agreement changed after this page loaded. Reload the page to review and accept the current version.'
        : 'Accepting requires the current version of the Terms of Service and Data Processing Agreement.';
    return NextResponse.json({ error }, { status: 400 });
  }

  try {
    // recordLegalAcceptance adds this version to the org's acceptance history
    // and updates the organizations cache in one statement, on the database
    // clock. Idempotent: re-accepting the version already on record adds no
    // row and keeps the original time, so a double click or a second tab
    // cannot move the record of when the founder agreed to this wording.
    // withTransaction is only how db.ts lends the dedicated client it writes
    // through — the connect route makes the same call next to its key write.
    const acceptance = await withTransaction((client) =>
      recordLegalAcceptance(client, orgId, 'banner'),
    );

    if (!acceptance) {
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
      version: acceptance.version,
      acceptedAt: acceptance.acceptedAt.toISOString(),
    });
  } catch (err) {
    // The version was already validated, so this is the database failing to
    // record a founder's agreement.
    reportError('legal.accept', err, { orgId });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export const POST = withErrorReporting('legal.accept', acceptLegalDocs);
