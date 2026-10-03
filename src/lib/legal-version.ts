/**
 * The version of the Terms of Service and Data Processing Agreement a founder
 * agrees to when they accept them. Recorded on the org as
 * organizations.legal_accepted_version, next to legal_accepted_at.
 *
 * BUMP THIS WHENEVER THE TEXT OF /legal/terms OR /legal/dpa CHANGES, including
 * filling in the bracketed placeholders in src/lib/legal.ts (they are part of
 * what those documents say). Bumping is what re-prompts acceptance: every org
 * whose recorded version differs sees the dashboard banner again, and a connect
 * form or banner loaded before the bump is refused until the founder reloads
 * and accepts the new text. Nothing bumps it automatically.
 *
 * Separate from LEGAL.lastUpdated in src/lib/legal.ts on purpose: that is
 * display text inside the documents (and still a placeholder); this is the key
 * acceptance is recorded against. The value is a date only so a human reading
 * the database can place it — nothing parses it, and any change to the string
 * is a new version. The wording a version refers to is whatever the legal pages
 * said at the commit that set it.
 *
 * Its own dependency-free module because the onboarding form and the dashboard
 * banner are client components and import it too.
 */
export const LEGAL_DOCS_VERSION = '2026-10-03';
