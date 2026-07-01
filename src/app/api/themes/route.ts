import { NextResponse } from 'next/server';
import { query, execute } from '@/lib/db';
import { clusterResponses } from '@/lib/openai';
import { verifyCronSecret } from '@/lib/auth';
import { reportingWeek } from '@/lib/week';

export async function POST(req: Request) {
  if (!verifyCronSecret(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Report on the week that just ended: [previous Monday, this Monday).
  const { weekStart, weekEnd, weekOfStr } = reportingWeek();
  const startIso = weekStart.toISOString();
  const endIso = weekEnd.toISOString();

  // At-most-once-per-week guard: a duplicate fire (restart, extra instance,
  // manual retry) loses the ON CONFLICT race and exits without re-spending
  // OpenAI tokens.
  const claimed = await execute(
    `INSERT INTO cron_runs (job, week_of) VALUES ('themes', $1)
     ON CONFLICT (job, week_of) DO NOTHING`,
    [weekOfStr],
  );
  if (claimed === 0) {
    return NextResponse.json({ skipped: 'already_ran', weekOf: weekOfStr });
  }

  const orgs = await query<{ id: string }>(
    "SELECT id FROM organizations WHERE plan IN ('starter', 'growth')",
  );

  if (!orgs.length) return NextResponse.json({ processed: 0, weekOf: weekOfStr });

  let processed = 0;

  for (const org of orgs) {
    const responses = await query<{ reason_category: string; open_text: string | null }>(
      `SELECT reason_category, open_text FROM survey_responses
       WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3`,
      [org.id, startIso, endIso],
    );

    if (responses.length < 2) continue;

    const input = responses
      .filter((r) => r.open_text)
      .map((r) => ({ text: r.open_text!, reason: r.reason_category }));

    if (input.length === 0) continue;

    let themes;
    try {
      themes = await clusterResponses(input);
    } catch (err) {
      console.error(`Theme clustering failed for org ${org.id}:`, err);
      continue;
    }

    const mrrRows = await query<{ mrr_lost: number }>(
      `SELECT mrr_lost FROM survey_responses
       WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3`,
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
       WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3 AND open_text IS NOT NULL`,
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
  }

  return NextResponse.json({ processed, weekOf: weekOfStr });
}

// Vercel Cron issues GET requests; alias to the same handler. Safe to expose as
// GET because it is CRON_SECRET-gated and idempotent (cron_runs guard).
export const GET = POST;
