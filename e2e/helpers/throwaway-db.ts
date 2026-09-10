/**
 * Guard for anything that destroys rows wholesale.
 *
 * Two callers wipe whatever TEST_DATABASE_URL names: e2e/global-setup.ts
 * truncates every application table, and the DB-gated purge suite
 * (src/app/api/purge/__tests__/route.db.test.ts) truncates before each test —
 * and the purge route it drives hard-deletes organizations. A copy-pasted
 * production URL in that variable is an irreversible mistake, so it is refused
 * rather than trusted.
 *
 * Deliberately dependency-free (no Playwright, no pg): it is imported by both
 * a Playwright global setup and a vitest suite, and neither should drag the
 * other's runner into its process.
 *
 * The two conditions together are what make this meaningful. "Local" alone
 * would still let a developer's own `churnlens` dev database through; a name
 * containing "test" alone would still allow a shared remote staging box.
 */

// A plain array, not a Set: this module is compiled by three different
// toolchains (Playwright, vitest, tsc with the repo's ES5-era target) and an
// array needs no downlevel-iteration support from any of them.
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];

/** `new URL` keeps IPv6 literals bracketed ("[::1]"); compare them unbracketed. */
function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1');
}

export function assertThrowawayDatabase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL is not a valid URL (${JSON.stringify(url)}). ` +
        'Expected something like postgresql://postgres:pw@127.0.0.1:55432/churnlens_test',
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  const database = parsed.pathname.replace(/^\//, '');

  const problems: string[] = [];
  if (!LOCAL_HOSTNAMES.includes(hostname)) {
    problems.push(`host "${hostname}" is not local (expected one of ${LOCAL_HOSTNAMES.join(', ')})`);
  }
  if (!/test/i.test(database)) {
    problems.push(`database "${database}" does not contain "test"`);
  }

  if (problems.length > 0) {
    throw new Error(
      [
        `Refusing to run against host "${hostname}", database "${database}": ${problems.join('; ')}.`,
        '',
        'This suite TRUNCATES every application table and hard-deletes organizations.',
        'Point TEST_DATABASE_URL at a throwaway local database whose name says so, e.g.',
        '  postgresql://postgres:pw@127.0.0.1:55432/churnlens_test',
        'which `npm run e2e:db up` creates for you.',
      ].join('\n'),
    );
  }
}
