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
  // takes users/survey_responses/themes/login_tokens/digest_sends/cron_runs
  // with it. unsubscribes is the deliberate exception — its FK to
  // organizations was dropped in the migration precisely so this DELETE
  // cannot take the opt-out suppression list down with the org.
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

  // (d) Abandoned signups: an org created 30+ days ago that never connected
  // Stripe, never connected Polar, and has no login_tokens row with
  // used_at set (an email address that requested a sign-in link and never
  // clicked it — never proved it controls that inbox, let alone used the
  // product). Safe to delete unprompted: nothing was ever configured, nobody
  // has ever authenticated into it, and there is no data (surveys, themes,
  // billing) that this would be destroying — only a stub account no human
  // ever confirmed they wanted.
  try {
    abandonedDeleted = await execute(
      `DELETE FROM organizations o
       WHERE o.created_at < now() - interval '30 days'
         AND o.stripe_api_key_enc IS NULL
         AND o.polar_subscription_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM login_tokens lt
           WHERE lt.org_id = o.id AND lt.used_at IS NOT NULL
         )`,
    );
  } catch (err) {
    console.error(`Purge ${dateStr}: abandoned-signup cleanup step failed:`, err);
    failed.push('abandoned_signups');
  }

  const result = { responses, themes, tokens, orgsDeleted, abandonedDeleted, failed };
  console.log(`[purge] ${dateStr} →`, result);

  await finishCronRun('purge', dateStr, {
    status: failed.length > 0 ? 'failed' : 'succeeded',
    processed: responses + themes + tokens + orgsDeleted + abandonedDeleted,
    failed: failed.length,
  });

  return NextResponse.json(result);
}

// Kept for manual triggering and any external scheduler that issues GET; the
// in-process scheduler in instrumentation.ts uses POST. Safe to expose as GET
// because it is CRON_SECRET-gated and idempotent (cron_runs guard).
export const GET = POST;
