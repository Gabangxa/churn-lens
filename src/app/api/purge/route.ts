import { NextResponse } from 'next/server';
import { query, execute } from '@/lib/db';
import { verifyCronSecret } from '@/lib/auth';
import { claimCronRun, finishCronRun, todayDateStr } from '@/lib/cron';
import { disconnectStripe } from '@/lib/stripe-disconnect';
import { LEGAL } from '@/lib/legal';

/**
 * Daily retention purge.
 *
 * Backs the promises in the privacy policy (s8), the DPA (s9) and the Terms
 * (s3, s12): survey data has a real retention window, and a founder who
 * requests account deletion from Settings actually gets erased after the
 * 30-day grace period. This is a daily job, not a weekly one — it reuses
 * `cron_runs` (job='purge') but keyed by calendar date (`week_of` holds
 * today's date, e.g. '2026-09-01') rather than a reporting week's Monday, so
 * claimCronRun's per-key at-most-once/retry semantics apply per day instead
 * of per week.
 *
 * Each step below is independently try/caught: a bug or transient failure in
 * one (say, a bad Stripe key on one org's disconnect) must not stop the
 * unrelated steps — a stuck abandoned-signup row shouldn't hold back the
 * survey_responses retention delete, and vice versa.
 */
export async function POST(req: Request) {
  if (!verifyCronSecret(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dateStr = todayDateStr();

  // At-most-once-per-day guard, with retry, exactly like the weekly jobs (see
  // src/lib/cron.ts claimCronRun) — just keyed by date instead of week.
  const claimed = await claimCronRun('purge', dateStr);
  if (!claimed) {
    return NextResponse.json({ skipped: 'already_ran', date: dateStr });
  }

  let responses = 0;
  let themes = 0;
  let tokens = 0;
  let orgsDeleted = 0;
  let abandonedDeleted = 0;
  let unsubscribesOrphaned = 0;
  let cronRunsPurged = 0;
  const failed: string[] = [];

  // (a) Survey-response retention (privacy policy s8 / DPA s9). Interval math
  // is done in SQL, not JS, so this is exact regardless of month length.
  try {
    responses = await execute(
      `DELETE FROM survey_responses WHERE created_at < now() - ($1 || ' months')::interval`,
      [LEGAL.surveyResponseRetentionMonths],
    );
  } catch (err) {
    console.error(`Purge ${dateStr}: survey_responses retention step failed:`, err);
    failed.push('survey_responses');
  }

  try {
    themes = await execute(
      `DELETE FROM themes WHERE week_of < now() - ($1 || ' months')::interval`,
      [LEGAL.surveyResponseRetentionMonths],
    );
  } catch (err) {
    console.error(`Purge ${dateStr}: themes retention step failed:`, err);
    failed.push('themes');
  }

  // (b) Expired sign-in tokens. A day of slack past expiry so a token that
  // expired seconds ago can't be deleted out from under a request that is
  // mid-verification against it.
  try {
    tokens = await execute(
      `DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'`,
    );
  } catch (err) {
    console.error(`Purge ${dateStr}: login_tokens cleanup step failed:`, err);
    failed.push('login_tokens');
  }

  // (c) Hard-delete orgs whose 30-day deletion grace period has elapsed.
  // Stripe disconnect first (best-effort, logs and continues on its own
  // failure — see disconnectStripe), then the row itself; ON DELETE CASCADE
  // takes users/survey_responses/themes/login_tokens/digest_sends with it —
  // every one of those tables carries an org_id FK. unsubscribes and
  // cron_runs are the two things that do NOT go with it: unsubscribes'
  // FK was dropped in the migration precisely so this DELETE cannot take the
  // opt-out suppression list down with the org (steps (e)/(f) below reclaim
  // both on their own, unrelated schedule), and cron_runs has no org_id at
  // all — it is keyed by (job, week_of/date), not by org.
  try {
    const dueOrgs = await query<{ id: string }>(
      `SELECT id FROM organizations WHERE deletion_requested_at < now() - ($1 || ' days')::interval`,
      [LEGAL.deletionWindowDays],
    );
    for (const org of dueOrgs) {
      try {
        await disconnectStripe(org.id);
        await execute('DELETE FROM organizations WHERE id = $1', [org.id]);
        orgsDeleted++;
      } catch (err) {
        console.error(`Purge ${dateStr}: hard-delete failed for org ${org.id}:`, err);
        failed.push(`org_delete:${org.id}`);
      }
    }
  } catch (err) {
    console.error(`Purge ${dateStr}: querying orgs due for deletion failed:`, err);
    failed.push('org_delete_query');
  }

  // (d) Abandoned signups: an org created 30+ days ago that has never been
  // signed into (last_login_at IS NULL — stamped durably by /api/auth/verify,
  // unlike login_tokens rows, which live 15 minutes and are deleted a day
  // after they expire by step (b) above; "no used token" would otherwise be
  // vacuously true for any founder who simply hasn't signed in within the
  // last day), never connected Stripe, never connected Polar, has no pending
  // deletion request of its own (that org is already handled, on its own
  // 30-day grace period, by step (c)), and has collected no survey response.
  // Safe to delete unprompted: nothing was ever configured, nobody has ever
  // authenticated into it, and there is no data this would be destroying —
  // only a stub account no human ever confirmed they wanted.
  try {
    abandonedDeleted = await execute(
      `DELETE FROM organizations o
       WHERE o.created_at < now() - interval '30 days'
         AND o.last_login_at IS NULL
         AND o.stripe_api_key_enc IS NULL
         AND o.polar_subscription_id IS NULL
         AND o.deletion_requested_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM survey_responses r WHERE r.org_id = o.id
         )`,
    );
  } catch (err) {
    console.error(`Purge ${dateStr}: abandoned-signup cleanup step failed:`, err);
    failed.push('abandoned_signups');
  }

  // (e) Opt-out records whose org no longer exists. unsubscribes has no FK to
  // organizations (dropped in the migration, on purpose, so step (c) above
  // can never cascade the suppression list away) — which means a row here
  // can outlive the org that created it, with nothing to ever clean it up on
  // its own. Once the org is gone there is no account left for it to protect
  // and it is unreachable personal data (an email address) sitting with no
  // purpose, so it is deleted once the org row it refers to is confirmed gone.
  try {
    unsubscribesOrphaned = await execute(
      `DELETE FROM unsubscribes u
       WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.org_id)`,
    );
  } catch (err) {
    console.error(`Purge ${dateStr}: orphaned unsubscribes cleanup step failed:`, err);
    failed.push('orphaned_unsubscribes');
  }

  // (f) cron_runs rows older than 90 days: pure operational history once a
  // week/day is long past — nothing ever reads a run that old — and unlike
  // every table in step (c), this one has no org_id, so it is never touched
  // by an org's deletion and needs its own reclaim.
  try {
    cronRunsPurged = await execute(`DELETE FROM cron_runs WHERE ran_at < now() - interval '90 days'`);
  } catch (err) {
    console.error(`Purge ${dateStr}: cron_runs cleanup step failed:`, err);
    failed.push('cron_runs');
  }

  const result = {
    responses,
    themes,
    tokens,
    orgsDeleted,
    abandonedDeleted,
    unsubscribesOrphaned,
    cronRunsPurged,
    failed,
  };
  console.log(`[purge] ${dateStr} →`, result);

  await finishCronRun('purge', dateStr, {
    status: failed.length > 0 ? 'failed' : 'succeeded',
    processed:
      responses + themes + tokens + orgsDeleted + abandonedDeleted + unsubscribesOrphaned + cronRunsPurged,
    failed: failed.length,
  });

  return NextResponse.json(result);
}

// Kept for manual triggering and any external scheduler that issues GET; the
// in-process scheduler in instrumentation.ts uses POST. Safe to expose as GET
// because it is CRON_SECRET-gated and idempotent (cron_runs guard).
export const GET = POST;
