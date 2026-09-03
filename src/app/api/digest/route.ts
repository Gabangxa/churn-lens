import { NextResponse } from 'next/server';
import { query, queryOne, queryCount, execute } from '@/lib/db';
import { getResend, FROM_EMAIL } from '@/lib/resend';
import { verifyCronSecret } from '@/lib/auth';
import { reportingWeek } from '@/lib/week';
import { claimCronRun, cronRunStatus, finishCronRun } from '@/lib/cron';

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
  // table, so running before themes has actually succeeded for this week would
  // silently send an empty/incomplete digest and then mark the week done,
  // never picking up the themes that show up later. Deferring — without
  // claiming — lets the next poll try again once themes has succeeded.
  const themesStatus = await cronRunStatus('themes', weekOfStr);
  if (themesStatus !== 'succeeded') {
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

  try {
    const themes = await query<{
      org_id: string;
      label: string;
      response_count: number;
      representative_quotes: string[];
      mrr_impact: number;
    }>(
      `SELECT org_id, label, response_count, representative_quotes, mrr_impact
       FROM themes WHERE week_of = $1 ORDER BY response_count DESC`,
      [weekOfStr],
    );

    if (!themes.length) {
      // No themes were produced for any org this week (nothing to report, not
      // a failure) — finish the run as succeeded so it isn't left 'running'
      // forever and isn't mistaken for a crash on the next poll.
      await finishCronRun('digest', weekOfStr, { status: 'succeeded', processed: 0, failed: 0 });
      return NextResponse.json({ sent: 0, weekOf: weekOfStr });
    }

    const byOrg = themes.reduce<Record<string, typeof themes>>((acc, t) => {
      acc[t.org_id] = acc[t.org_id] ?? [];
      acc[t.org_id].push(t);
      return acc;
    }, {});

    const orgIds = Object.keys(byOrg);

    const orgs = await query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE id = ANY($1)`,
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

        if (!founderUser?.email) continue;

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

    await finishCronRun('digest', weekOfStr, {
      status: failed > 0 ? 'failed' : 'succeeded',
      processed: sent,
      failed,
    });

    return NextResponse.json({ sent, failed, weekOf: weekOfStr });
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
}

// Kept for manual triggering and any external scheduler that issues GET; the
// in-process scheduler in instrumentation.ts uses POST. Safe to expose as GET
// because it is CRON_SECRET-gated and idempotent (cron_runs guard).
export const GET = POST;
