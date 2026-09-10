import { expect, test } from '@playwright/test';
import {
  closeDb,
  daysAgo,
  query,
  queryOne,
  resetCronRun,
  seedOrg,
  seedSurveyResponse,
  seedUnsubscribe,
  uniqueEmail,
} from './helpers/db';
import { cronRequest } from './helpers/session';

const CRON_ROUTES = ['/api/themes', '/api/digest', '/api/purge'];

/**
 * Mirrors reportingWeek() in src/lib/week.ts: the Monday the current
 * reporting week began, which is the key both weekly jobs claim under.
 * Recomputed here so the assertion does not simply agree with the code it is
 * checking.
 */
function reportingWeekOfStr(now: Date = new Date()): string {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const weekEnd = new Date(today);
  weekEnd.setUTCDate(weekEnd.getUTCDate() - daysSinceMonday);
  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  return weekStart.toISOString().slice(0, 10);
}

/**
 * The cron endpoints delete data and email founders, and the only thing
 * standing between them and the open internet is a bearer token. The purge
 * job in particular is the one place the app hard-deletes an account: its
 * predicates have unit and DB-level tests, but nothing else proves the wired
 * route, the CRON_SECRET check and the cron_runs bookkeeping behave together
 * against a running server.
 */
test.describe('cron endpoints', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test('every cron route rejects a wrong bearer token', async ({ request }) => {
    for (const path of CRON_ROUTES) {
      const res = await cronRequest(request, path, { secret: 'not-the-cron-secret' });
      expect(res.status(), `${path} should reject a bad secret`).toBe(401);
    }
  });

  test('the purge job erases exactly what retention says it should', async ({ request }) => {
    // (A) grace period elapsed → hard delete, and its opt-out row is orphaned.
    const { orgId: orgA } = await seedOrg({
      email: uniqueEmail('purge-deleted'),
      name: 'A — deletion requested 31 days ago',
      deletionRequestedAt: daysAgo(31),
    });
    await seedUnsubscribe(orgA, 'optout@customer.test');

    // (B) abandoned signup: 40 days old, never signed in, nothing configured.
    const { orgId: orgB } = await seedOrg({
      email: uniqueEmail('purge-abandoned'),
      name: 'B — abandoned signup',
      createdAt: daysAgo(40),
    });

    // (C) a fresh keyless signup — the same shape as B, minus the age.
    const { orgId: orgC } = await seedOrg({
      email: uniqueEmail('purge-fresh'),
      name: 'C — signed up today',
    });

    // (D) a live org whose oldest response has aged out of the 24-month window.
    const { orgId: orgD } = await seedOrg({
      email: uniqueEmail('purge-retention'),
      name: 'D — mixed-age responses',
      withStripeKey: true,
      lastLoginAt: daysAgo(1),
    });
    await seedSurveyResponse(orgD, {
      customerEmail: 'old@customer.test',
      createdAt: daysAgo(760), // ≈25 months, comfortably past the 24-month window
    });
    await seedSurveyResponse(orgD, {
      customerEmail: 'recent@customer.test',
      createdAt: daysAgo(2),
    });

    // global-setup truncates cron_runs and serverEnv disables the in-process
    // scheduler, so nothing should hold today's claim — kept anyway because
    // `reuseExistingServer` can adopt a server someone started by hand,
    // without the kill switch, whose scheduler already ran purge on boot.
    await resetCronRun('purge');

    const res = await cronRequest(request, '/api/purge');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.responses).toBe(1);
    expect(body.orgsDeleted).toBe(1);
    expect(body.abandonedDeleted).toBe(1);
    expect(body.unsubscribesOrphaned).toBe(1);
    expect(body.failed).toEqual([]);

    const survivors = await query<{ id: string }>(
      'SELECT id FROM organizations WHERE id = ANY($1::uuid[])',
      [[orgA, orgB, orgC, orgD]],
    );
    expect(survivors.map((row) => row.id).sort()).toEqual([orgC, orgD].sort());

    const remaining = await query<{ customer_email: string }>(
      'SELECT customer_email FROM survey_responses WHERE org_id = $1',
      [orgD],
    );
    expect(remaining.map((row) => row.customer_email)).toEqual(['recent@customer.test']);

    // Opt-out records outlive their org by design — but not once the org row
    // itself is gone and the address is unreachable personal data.
    const orphans = await query('SELECT 1 FROM unsubscribes WHERE org_id = $1', [orgA]);
    expect(orphans).toHaveLength(0);

    const purgeRun = await queryOne<{ status: string; failed: number }>(
      'SELECT status, failed FROM cron_runs WHERE job = $1 ORDER BY ran_at DESC LIMIT 1',
      ['purge'],
    );
    expect(purgeRun).not.toBeNull();
    expect(purgeRun!.status).toBe('succeeded');
    expect(purgeRun!.failed).toBe(0);
  });

  test('themes and digest complete for the current reporting week', async ({ request }) => {
    const weekOf = reportingWeekOfStr();

    // These are genuine first runs: global-setup truncated cron_runs and the
    // server's in-process scheduler is disabled (E2E_DISABLE_SCHEDULER), so
    // nothing else can have claimed this week. That makes the skip paths
    // assertable — `already_ran` here would mean the claim leaked to another
    // caller, and `deferred` would mean digest ran before themes was terminal.
    const themes = await cronRequest(request, '/api/themes');
    expect(themes.status()).toBe(200);
    const themesBody = await themes.json();
    expect(themesBody.skipped).toBeUndefined();
    expect(themesBody.processed).toBeDefined();
    expect(themesBody.weekOf).toBe(weekOf);

    const digest = await cronRequest(request, '/api/digest');
    expect(digest.status()).toBe(200);
    const digestBody = await digest.json();
    expect(digestBody.skipped).toBeUndefined();
    expect(digestBody.deferred).toBeUndefined();
    expect(digestBody.sent).toBeDefined();
    expect(digestBody.weekOf).toBe(weekOf);

    for (const job of ['themes', 'digest']) {
      const run = await queryOne<{ status: string }>(
        'SELECT status FROM cron_runs WHERE job = $1 AND week_of = $2::date',
        [job, weekOf],
      );
      expect(run, `${job} should have a cron_runs row for ${weekOf}`).not.toBeNull();
      expect(run!.status, `${job} run for ${weekOf}`).toBe('succeeded');
    }
  });
});
