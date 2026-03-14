import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';
import { clusterResponses } from '@/lib/openai';

/**
 * POST /api/themes
 *
 * Nightly cron job trigger — clusters this week's responses per org.
 * Secured by a static CRON_SECRET header.
 *
 * Vercel Cron config (vercel.json):
 *   { "crons": [{ "path": "/api/themes", "schedule": "0 6 * * 1" }] }
 *   → runs every Monday at 06:00 UTC (before the weekly digest fires at 07:00)
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminClient();

  // Find the start of the current week (Monday)
  const weekOf = new Date();
  weekOf.setDate(weekOf.getDate() - weekOf.getDay() + 1); // Monday
  weekOf.setHours(0, 0, 0, 0);

  // Get all orgs on paid plans
  const { data: orgs } = await db
    .from('organizations')
    .select('id')
    .in('plan', ['starter', 'growth']);

  if (!orgs) return NextResponse.json({ processed: 0 });

  let processed = 0;

  for (const org of orgs) {
    // Fetch unsynthesised responses from this week
    const { data: responses } = await db
      .from('survey_responses')
      .select('reason_category, open_text')
      .eq('org_id', org.id)
      .gte('surveyed_at', weekOf.toISOString())
      .not('surveyed_at', 'is', null);

    if (!responses || responses.length < 2) continue;

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

    // Calculate MRR impact per theme
    const { data: mrrData } = await db
      .from('survey_responses')
      .select('mrr_lost')
      .eq('org_id', org.id)
      .gte('surveyed_at', weekOf.toISOString());

    const totalMrr = (mrrData ?? []).reduce((sum, r) => sum + (r.mrr_lost ?? 0), 0);

    // Upsert theme records
    const themeRows = themes.map((theme) => ({
      org_id: org.id,
      week_of: weekOf.toISOString().split('T')[0],
      label: theme.label,
      response_count: theme.count,
      representative_quotes: theme.quotes,
      mrr_impact: Math.round((theme.count / input.length) * totalMrr),
    }));

    await db.from('themes').upsert(themeRows, {
      onConflict: 'org_id,week_of,label',
    });

    // Stamp theme_tags on individual responses (best-effort)
    for (const theme of themes) {
      for (const quote of theme.quotes) {
        await db
          .from('survey_responses')
          .update({ theme_tags: [theme.label] })
          .eq('org_id', org.id)
          .eq('open_text', quote);
      }
    }

    processed++;
  }

  return NextResponse.json({ processed, weekOf: weekOf.toISOString() });
}
