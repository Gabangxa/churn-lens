import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { assertThrowawayDatabase, TEST_DATABASE_URL } from './env';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Every application table, listed explicitly rather than discovered from
 * information_schema: the point of this list is that adding a table forces
 * someone to decide whether the suite should be wiping it, instead of a
 * wildcard silently truncating something a future migration introduces.
 *
 * users_dedupe_backup is scripts/migrate.js's recoverable-delete snapshot —
 * empty in a fresh test DB, but truncated too so a run can never inherit rows
 * from a previous one.
 */
const APPLICATION_TABLES = [
  'organizations',
  'users',
  'survey_responses',
  'themes',
  'unsubscribes',
  'login_tokens',
  'digest_sends',
  'cron_runs',
  'users_dedupe_backup',
];

function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

async function connectOrExplain(): Promise<Client> {
  const client = new Client({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    return client;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        `e2e: cannot reach the test database at ${redact(TEST_DATABASE_URL)} — ${reason}`,
        '',
        'Start a throwaway Postgres first:',
        '',
        '  npm run e2e:db up',
        '',
        'Or point TEST_DATABASE_URL at your own throwaway database.',
        'NEVER point it at a database you care about: every table below is truncated on each run.',
      ].join('\n'),
    );
  }
}

/**
 * Fail fast on an unreachable DB, apply the schema, then hand every spec the
 * same clean slate. Truncation happens once per run rather than per test:
 * the specs seed unique emails/orgs, so they do not need isolation from each
 * other — they need isolation from the PREVIOUS run, which is what makes a
 * second `npm run e2e` against the same database behave like the first.
 */
export default async function globalSetup(): Promise<void> {
  // First, before anything opens a connection: everything below this line
  // destroys rows, and the only thing standing between that and a real
  // database is the value of TEST_DATABASE_URL.
  assertThrowawayDatabase(TEST_DATABASE_URL);

  const client = await connectOrExplain();

  try {
    // The migration script is a child process on purpose: it is the exact
    // command production runs (Railway pre-deploy), so the e2e schema cannot
    // drift from the deployed one via some test-only shortcut.
    const { stderr } = await execFileAsync('node', ['scripts/migrate.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    });
    if (stderr.trim()) console.error(`[e2e] migrate stderr: ${stderr.trim()}`);

    await client.query(
      `TRUNCATE TABLE ${APPLICATION_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
    );
    console.log(`[e2e] schema migrated and ${APPLICATION_TABLES.length} tables truncated.`);
  } finally {
    await client.end();
  }
}
