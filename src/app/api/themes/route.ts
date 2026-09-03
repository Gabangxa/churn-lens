import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { MAX_RESPONSES_PER_BATCH, clusterResponses } from '@/lib/openai';
import { verifyCronSecret } from '@/lib/auth';
import { reportingWeek } from '@/lib/week';
import { claimCronRun, finishCronRun } from '@/lib/cron';

export async function POST(req: Request) {
  if (!verifyCronSecret(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Report on the week that just ended: [previous Monday, this Monday).
  const { weekStart, weekEnd, weekOfStr } = reportingWeek();
  const startIso = weekStart.toISOString();
  const endIso = weekEnd.toISOString();

  // At-most-once-per-week guard, with retry: a duplicate fire (restart, extra
  // instance, manual retry) loses the claim and exits without re-spending
  // OpenAI tokens; a week that previously failed or crashed mid-run wins the
  // claim again. See src/lib/cron.ts for the exact semantics.
  const claimed = await claimCronRun('themes', weekOfStr);
  if (!claimed) {
    return NextResponse.json({ skipped: 'already_ran', weekOf: weekOfStr });
  }

  let processed = 0;
  let failed = 0;

  // Everything from here on has claimed the run and MUST finish it — an
  // unexpected throw that skipped finishCronRun would leave the row stuck at
  // status='running' forever (the same failure mode this replaces, just one
  // level up), so any exception that escapes the per-org loop is caught here,
  // recorded as a failed run, and re-surfaced as a 500 rather than swallowed.
  try {
    const orgs = await query<{ id: string }>(
      "SELECT id FROM organizations WHERE plan IN ('starter', 'growth')",
    );

    for (const org of orgs) {
      try {
        // A retry after a partial failure should not re-spend OpenAI tokens on
        // orgs this run already finished successfully before the crash.
        const existing = await query<{ id: string }>(
          `SELECT id FROM themes WHERE org_id = $1 AND week_of = $2 LIMIT 1`,
          [org.id, weekOfStr],
        );
        if (existing.length > 0) continue;

        const responses = await query<{ reason_category: string; open_text: string | null }>(
          `SELECT reason_category, open_text FROM survey_responses
           WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3 AND NOT is_test`,
          [org.id, startIso, endIso],
        );

        if (responses.length < 2) continue;

        const input = responses
          .filter((r) => r.open_text)
          .map((r) => ({ text: r.open_text!, reason: r.reason_category }));

        if (input.length === 0) continue;

        // Trim here rather than letting clusterResponses do it silently. The theme
        // counts it returns describe only the responses the model actually saw, and
        // mrr_impact below divides by this array's length — if the library trimmed
        // the batch and we kept the untrimmed denominator, every theme's MRR would
        // be scaled down by the ratio of the two, understating churn cost exactly
        // where founders read it. Same ceiling either way; the library keeps its own
        // copy as a backstop for other callers.
        if (input.length > MAX_RESPONSES_PER_BATCH) {
          console.warn(
            `Org ${org.id}: clustering the first ${MAX_RESPONSES_PER_BATCH} of ${input.length} ` +
              `responses for ${weekOfStr}; theme counts and MRR describe that sample.`,
          );
          input.length = MAX_RESPONSES_PER_BATCH;
        }

        let themes;
        try {
          themes = await clusterResponses(input);
        } catch (err) {
          console.error(`Theme clustering failed for org ${org.id}:`, err);
          failed++;
          continue;
        }

        const mrrRows = await query<{ mrr_lost: number }>(
          `SELECT mrr_lost FROM survey_responses
           WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3 AND NOT is_test`,
          [org.id, startIso, endIso],
        );

        const totalMrr = mrrRows.reduce((sum, r) => sum + (r.mrr_lost ?? 0), 0);

        for (const theme of themes) {
          const mrrImpact = Math.round((theme.count / input.length) * totalMrr);
          await query(
            `INSERT INTO themes (org_id, week_of, label, response_count, representative_quotes, mrr_impact)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (org_id, week_of, label)
             DO UPDATE SET response_count = $4, representative_quotes = $5, mrr_impact = $6`,
            [org.id, weekOfStr, theme.label, theme.count, theme.quotes, mrrImpact],
          );
        }

        // Back-tag responses by matching quotes to row IDs — never update by open_text
        // directly as it risks matching the wrong row if two responses are identical.
        // Match on a normalized form since GPT frequently trims/pads verbatim quotes.
        const responseRows = await query<{ id: string; open_text: string | null }>(
          `SELECT id, open_text FROM survey_responses
           WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3 AND NOT is_test AND open_text IS NOT NULL`,
          [org.id, startIso, endIso],
        );

        const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

        for (const theme of themes) {
          for (const quote of theme.quotes) {
            const q = norm(quote);
            const match = responseRows.find(
              (r) => r.open_text && norm(r.open_text) === q,
            );
            if (match) {
              await query(
                `UPDATE survey_responses SET theme_tags = $1 WHERE id = $2`,
                [[theme.label], match.id],
              );
            }
          }
        }

        processed++;
      } catch (err) {
        // One org's DB error (or anything else unexpected) must not abort the
        // rest of the run — every other org still gets clustered this week.
        console.error(`Themes: org ${org.id} failed for week ${weekOfStr}:`, err);
        failed++;
      }
    }

    await finishCronRun('themes', weekOfStr, {
      status: failed > 0 ? 'failed' : 'succeeded',
      processed,
      failed,
    });

    return NextResponse.json({ processed, failed, weekOf: weekOfStr });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Themes: run failed for week ${weekOfStr}:`, err);
    await finishCronRun('themes', weekOfStr, {
      status: 'failed',
      processed,
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
