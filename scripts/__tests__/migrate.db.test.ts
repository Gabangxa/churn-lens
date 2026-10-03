import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { Client } from 'pg';
import { assertThrowawayDatabase } from '../../e2e/helpers/throwaway-db';

/**
 * scripts/migrate.js is Railway's preDeploy command, so it runs against the
 * live database on every deploy while the old build is still serving. Most of
 * its steps are ALTER TABLE ... IF NOT EXISTS, and ALTER TABLE takes its
 * ACCESS EXCLUSIVE lock BEFORE it checks whether there is anything to do — so
 * every deploy, not just the ones that change the schema, queues for that lock.
 *
 * The harm is the queue, not the migration: while an ACCESS EXCLUSIVE request
 * waits, every later reader and writer of that table waits behind it. One stray
 * open transaction (an idle-in-transaction psql session, a stuck request) would
 * stall all live traffic on organizations for as long as it stayed open. With
 * lock_timeout set, the migration gives up instead, exits non-zero so the
 * deploy fails, and the queue behind it drains.
 *
 * Runs the real script as a child process, as e2e/global-setup.ts does, so it
 * proves the connection settings production uses rather than a copy of them.
 * Skipped unless TEST_DATABASE_URL points at a migrated throwaway database. It
 * holds a lock on organizations for several seconds, which is why it relies on
 * vitest.config.ts serialising the DB suites.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATE_SCRIPT = resolve(__dirname, '../migrate.js');

// Comfortably above the script's lock_timeout plus node start-up, far below
// "waits for ever": a migration still running at this point is not timing out.
const MIGRATE_DEADLINE_MS = 30_000;

interface MigrateRun {
  code: number | null;
  stderr: string;
  killedAtDeadline: boolean;
}

function runMigrate(): Promise<MigrateRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', [MIGRATE_SCRIPT], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let killedAtDeadline = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => {
      killedAtDeadline = true;
      child.kill('SIGKILL');
    }, MIGRATE_DEADLINE_MS);
    child.on('error', (err) => {
      clearTimeout(deadline);
      rejectRun(err);
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      resolveRun({ code, stderr, killedAtDeadline });
    });
  });
}

/** True once some session is queued, not yet granted, for ACCESS EXCLUSIVE on organizations. */
async function accessExclusiveWaitOnOrganizations(observer: Client): Promise<boolean> {
  const { rows } = await observer.query(
    `SELECT 1 FROM pg_locks
     WHERE relation = 'organizations'::regclass
       AND mode = 'AccessExclusiveLock'
       AND NOT granted`,
  );
  return rows.length > 0;
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('scripts/migrate.js against a table someone else has locked', () => {
  const openClients: Client[] = [];

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    openClients.push(client);
    return client;
  }

  beforeAll(() => {
    assertThrowawayDatabase(TEST_DATABASE_URL!);
  });

  afterEach(async () => {
    // end() on a session with an open transaction rolls it back, so a failed
    // assertion never leaves the lock behind for the next suite.
    await Promise.all(openClients.splice(0).map((client) => client.end().catch(() => undefined)));
  });

  it(
    'gives up on the lock, exits non-zero, and lets the traffic queued behind it through',
    async () => {
      // The stray transaction: it read organizations and never finished.
      // ACCESS SHARE is the weakest lock there is — a plain SELECT takes it —
      // and it still conflicts with ALTER TABLE's ACCESS EXCLUSIVE.
      const stray = await connect();
      await stray.query('BEGIN');
      await stray.query('LOCK TABLE organizations IN ACCESS SHARE MODE');

      const migration = runMigrate();

      // Live traffic arriving while the migration waits for its lock: it
      // queues behind the migration's pending request, not beside the stray
      // reader it does not actually conflict with.
      const observer = await connect();
      const waitStarted = Date.now();
      while (!(await accessExclusiveWaitOnOrganizations(observer))) {
        if (Date.now() - waitStarted > MIGRATE_DEADLINE_MS) {
          throw new Error('migrate.js never queued for a lock on organizations');
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const liveReader = await connect();
      // Settled into a value so a failing assertion above it cannot leave a
      // rejection unhandled when afterEach closes the connection under it.
      const liveRead = liveReader.query('SELECT count(*) FROM organizations').then(
        () => 'answered',
        (err: Error) => `failed: ${err.message}`,
      );

      const run = await migration;

      expect(run.killedAtDeadline, 'migrate.js was still waiting for the lock: no lock_timeout').toBe(false);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(/lock timeout/);
      // The stray transaction is still open, yet the reader gets through:
      // the stall lasted lock_timeout, not as long as the stray session.
      expect(await liveRead).toBe('answered');

      // And once the lock is free, the same deploy succeeds on retry: every
      // step is idempotent, so the run that gave up left nothing to repair.
      await stray.query('ROLLBACK');
      const retry = await runMigrate();
      expect(retry.stderr).not.toMatch(/Migration failed/);
      expect(retry.code).toBe(0);
    },
    MIGRATE_DEADLINE_MS * 3,
  );
});
