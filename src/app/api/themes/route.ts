import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { clusterResponses } from '@/lib/openai';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const weekOf = new Date();
  weekOf.setDate(weekOf.getDate() - weekOf.getDay() + 1);
  weekOf.setHours(0, 0, 0, 0);

  const orgs = await query<{ id: string }>(
    "SELECT id FROM organizations WHERE plan IN ('starter', 'growth')",
  );

  if (!orgs.length) return NextResponse.json({ processed: 0 });

  let processed = 0;

  for (const org of orgs) {
    const responses = await query<{ reason_category: string; open_text: string | null }>(
      `SELECT reason_category, open_text FROM survey_responses
       WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at IS NOT NULL`,
      [org.id, weekOf.toISOString()],
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
       WHERE org_id = $1 AND surveyed_at >= $2`,
      [org.id, weekOf.toISOString()],
    );

    const totalMrr = mrrRows.reduce((sum, r) => sum + (r.mrr_lost ?? 0), 0);

    const weekOfStr = weekOf.toISOString().split('T')[0];

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

    for (const theme of themes) {
      for (const quote of theme.quotes) {
        await query(
          `UPDATE survey_responses SET theme_tags = $1
           WHERE org_id = $2 AND open_text = $3`,
          [[theme.label], org.id, quote],
        );
      }
    }

    processed++;
  }

  return NextResponse.json({ processed, weekOf: weekOf.toISOString() });
}
