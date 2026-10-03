import { hasUnfilledPlaceholders } from './legal';

/**
 * The hand-maintained part of the version of the Terms of Service and Data
 * Processing Agreement a founder agrees to. Never compared or recorded on its
 * own: currentLegalDocsVersion() below is the version the app asks for and
 * records, as organizations.legal_accepted_version and in legal_acceptances.
 *
 * BUMP THIS WHENEVER THE TEXT OF /legal/terms, /legal/dpa OR /legal/privacy
 * CHANGES, including filling in the bracketed placeholders in src/lib/legal.ts
 * (they are part of what those documents say). Bumping is what re-prompts
 * acceptance: every org whose recorded version differs sees the dashboard
 * banner again, and a connect form or banner loaded before the bump is refused
 * until the founder reloads and accepts the new text.
 * src/lib/__tests__/legal-version.test.ts fails until you do: it hashes
 * everything those pages render from and compares it with LEGAL_DOCS_SHA256.
 *
 * Separate from LEGAL.lastUpdated in src/lib/legal.ts on purpose: that is
 * display text inside the documents (and still a placeholder); this is the key
 * acceptance is recorded against. The value is a date only so a human reading
 * the database can place it — nothing parses it, and any change to the string
 * is a new version. The wording a version refers to is whatever the legal pages
 * said at the commit that set it.
 *
 * A module that imports nothing but legal.ts (which imports nothing) because
 * the onboarding form and the dashboard banner are client components and
 * import it too, as does the Playwright suite.
 */
export const LEGAL_DOCS_VERSION = '2026-10-03';

/**
 * sha256 of what the legal pages render from, as of LEGAL_DOCS_VERSION. Only
 * ever changed together with it; the guard test prints the new value.
 */
export const LEGAL_DOCS_SHA256 = '493c1793719df5d05659f1df74b25c720a3478985fd6e583a67900cb351f139f';

/**
 * The version a founder is asked to accept, and the one recorded when they do.
 *
 * '-draft' while legal.ts still has unfilled placeholders: those pages carry a
 * banner saying "Draft — do not rely on it", and an acceptance of them must
 * never read as acceptance of the finished contract. It also means filling in
 * legal.ts changes this value by itself — every org is asked again and every
 * draft acceptance stays recognisable — even before anyone bumps
 * LEGAL_DOCS_VERSION (the guard test makes them bump it anyway).
 *
 * Every check uses this: the connect route and POST /api/legal/accept refuse
 * any other value, the dashboard shows its banner to any org whose recorded
 * version differs, and the onboarding form and the banner send it.
 */
export function currentLegalDocsVersion(): string {
  return hasUnfilledPlaceholders() ? `${LEGAL_DOCS_VERSION}-draft` : LEGAL_DOCS_VERSION;
}
