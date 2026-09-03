import { NextResponse } from 'next/server';
import { query, queryOne, queryCount, execute } from '@/lib/db';
import { getResend, FROM_EMAIL } from '@/lib/resend';
import { verifyCronSecret } from '@/lib/auth';
import { reportingWeek } from '@/lib/week';
import { claimCronRun, cronRunRecord, finishCronRun, MAX_ATTEMPTS } from '@/lib/cron';

interface ThemeRow {
  org_id: string;
  label: string;
  response_count: number;
  representative_quotes: string[];
  mrr_impact: number;
}

export async function POST(req: Request) {
  if (!verifyCronSecret(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Report on the week that just ended: [previous Monday, this Monday).
  const { weekStart, weekEnd, weekOfStr } = reportingWeek();
  const startIso = weekStart.toISOString();
  const endIso = weekEnd.toISOString();

  // Themes and digest are two separate crons with no ordering guarantee
  // between them (the scheduler fires digest an hour after themes, but a slow
  // or retried themes run can still be in flight). Digest reads the `themes`
  // table, so running before themes has reached a TERMINAL state for this
  // week would silently send an empty/incomplete digest and then mark the
  // week done, never picking up themes that show up later.
  //
  // Terminal means 'succeeded', OR 'failed' with attempts exhausted
  // (>= MAX_ATTEMPTS) — not simply "not succeeded". Themes marks the whole
  // week 'failed' the moment ANY single org's clustering throws, even if
  // every other org clustered fine; requiring status === 'succeeded' here
  // would then defer forever and silence every founder's digest over one
  // poison org, since the scheduler stops retrying themes after
  // MAX_ATTEMPTS. Once themes has given up retrying, whatever theme rows
  // exist are what they're going to get — and digest already only emails
  // orgs that have theme rows, so a partial themes run just means a partial
  // (not wrong) digest.
  const themesRecord = await cronRunRecord('themes', weekOfStr);
  const themesTerminal =
    themesRecord?.status === 'succeeded' ||
    (themesRecord?.status === 'failed' && themesRecord.attempts >= MAX_ATTEMPTS);
  if (!themesTerminal) {
    return NextResponse.json({ deferred: 'themes_not_ready', weekOf: weekOfStr });
  }

  // At-most-once-per-week guard, with retry: a duplicate fire (restart, extra
  // instance, manual retry) loses the claim and exits without re-emailing; a
  // week that previously failed or crashed mid-run wins the claim again. Per-
  // org de-dup against digest_sends (below) is what makes that retry safe to
  // re-run without double-emailing founders who already got this week's mail.
  const claimed = await claimCronRun('digest', weekOfStr);
  if (!claimed) {
    return NextResponse.json({ sent: 0, skipped: 'already_ran', weekOf: weekOfStr });
  }

  let sent = 0;
  let failed = 0;
  let themes: ThemeRow[];

  // Only the read-and-loop work lives in this try: an unexpected throw here
  // means the claimed run never got a chance to record its real outcome, so
  // it's caught and reported as failed. Every success-path finishCronRun call
  // below is deliberately OUTSIDE this try/catch — see the comment there.
  try {
    themes = await query<ThemeRow>(
      `SELECT org_id, label, response_count, representative_quotes, mrr_impact
       FROM themes WHERE week_of = $1 ORDER BY response_count DESC`,
      [weekOfStr],
    );

    if (themes.length) {
      const byOrg = themes.reduce<Record<string, ThemeRow[]>>((acc, t) => {
        acc[t.org_id] = acc[t.org_id] ?? [];
        acc[t.org_id].push(t);
        return acc;
      }, {});

      const orgIds = Object.keys(byOrg);

      // Plan-filtered like themes: an org that downgraded off starter/growth
      // between themes' 06:00 run and digest's 07:00 run must not get billed
      // a founder digest it no longer pays for, even though it still has
      // theme rows for this week.
      const orgs = await query<{ id: string; name: string }>(
        `SELECT id, name FROM organizations WHERE id = ANY($1) AND plan IN ('starter', 'growth')`,
        [orgIds],
      );

      for (const org of orgs) {
        try {
          // Never re-email a founder who already got this week's digest — the
          // send itself can't be made idempotent (Resend has no dedup key here),
          // so a retry after a partial failure relies on this row instead.
          const alreadySent = await queryOne<{ org_id: string }>(
            `SELECT org_id FROM digest_sends WHERE org_id = $1 AND week_of = $2`,
            [org.id, weekOfStr],
          );
          if (alreadySent) continue;

          const founderUser = await queryOne<{ email: string; name: string | null }>(
            `SELECT email, name FROM users WHERE org_id = $1 AND role = 'owner' LIMIT 1`,
            [org.id],
          );

          if (!founderUser?.email) {
            console.warn(`Digest: org ${org.id} has no owner user with an email — skipping.`);
            continue;
          }

          const orgThemes = (byOrg[org.id] ?? []).slice(0, 3);

          const totalResponses = await queryCount(
            `SELECT COUNT(*) FROM survey_responses WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3 AND NOT is_test`,
            [org.id, startIso, endIso],
          );

          const mrrRows = await query<{ mrr_lost: number }>(
            `SELECT mrr_lost FROM survey_responses WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3 AND NOT is_test`,
            [org.id, startIso, endIso],
          );

          const totalMrr = mrrRows.reduce((s, r) => s + (r.mrr_lost ?? 0), 0);

          const firstName = founderUser.name?.split(' ')[0] ?? 'there';
          const appBase = process.env.NEXT_PUBLIC_APP_URL ?? '';
          const dashboardUrl = `${appBase}/dashboard`;
          const settingsUrl = `${appBase}/settings`;

          const themeLines = orgThemes
            .map(
              (t, i) =>
                `#${i + 1}  ${t.label}  (${t.response_count} response${t.response_count !== 1 ? 's' : ''}, $${t.mrr_impact} MRR)\n` +
                t.representative_quotes.map((q: string) => `      > "${q}"`).join('\n'),
            )
            .join('\n\n');

          const body = `Hey ${firstName},

Here's your ChurnLens digest for the week of ${weekOfStr}:

──────────────────────────────
${totalResponses ?? 0} cancellations  ·  $${totalMrr} MRR lost
──────────────────────────────

TOP REASONS CUSTOMERS LEFT:

${themeLines}

──────────────────────────────

See all responses: ${dashboardUrl}

Until next Monday,
ChurnLens

---
You're receiving this because you're on the Starter or Growth plan.
Manage preferences: ${settingsUrl}`;

          // The Resend SDK resolves with `{ data: null, error }` on failure — it
          // does NOT throw, for HTTP errors or for network faults. Left
          // unchecked, every failed send still incremented `sent` below.
          const { error } = await getResend().emails.send({
            from: FROM_EMAIL,
            to: founderUser.email,
            subject: `ChurnLens weekly: ${orgThemes[0]?.label ?? 'churn themes'} + ${totalResponses ?? 0} cancellations`,
            text: body,
          });

          if (error) {
            console.error(`Digest: send failed for org ${org.id}, week ${weekOfStr}:`, error);
            failed++;
            continue;
          }

          await execute(
            `INSERT INTO digest_sends (org_id, week_of) VALUES ($1, $2)
             ON CONFLICT (org_id, week_of) DO NOTHING`,
            [org.id, weekOfStr],
          );

          sent++;
        } catch (err) {
          // One org's DB error (or anything else unexpected) must not abort the
          // rest of the run — every other founder still gets their digest.
          console.error(`Digest: org ${org.id} failed for week ${weekOfStr}:`, err);
          failed++;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Digest: run failed for week ${weekOfStr}:`, err);
    await finishCronRun('digest', weekOfStr, {
      status: 'failed',
      processed: sent,
      failed,
      error: message,
    });
    return NextResponse.json({ error: message, weekOf: weekOfStr }, { status: 500 });
  }

  if (!themes.length) {
    // No themes were produced for any org this week (nothing to report, not
    // a failure). Outside the try/catch above for the same reason as the
    // final finishCronRun below: a failing UPDATE here shouldn't be caught
    // and re-reported as a fresh failure of work that already completed.
    await finishCronRun('digest', weekOfStr, { status: 'succeeded', processed: 0, failed: 0 });
    return NextResponse.json({ sent: 0, weekOf: weekOfStr });
  }

  // Deliberately outside the try/catch above: if this UPDATE itself throws (a
  // transient DB blip right after the real work already finished), we don't
  // want to catch it here and re-report the run as freshly 'failed' — the
  // sends already went out. Let it surface as a raw 500; cron_runs stays
  // 'running' and the next poll's stale-running reclaim (or a manual retry)
  // picks it back up, without burning an attempt on what was only a
  // bookkeeping failure.
  await finishCronRun('digest', weekOfStr, {
    status: failed > 0 ? 'failed' : 'succeeded',
    processed: sent,
    failed,
  });

  return NextResponse.json({ sent, failed, weekOf: weekOfStr });
}

// Kept for manual triggering and any external scheduler that issues GET; the
// in-process scheduler in instrumentation.ts uses POST. Safe to expose as GET
// because it is CRON_SECRET-gated and idempotent (cron_runs guard).
export const GET = POST;
