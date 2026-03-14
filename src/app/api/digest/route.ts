import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';
import { resend, FROM_EMAIL } from '@/lib/resend';

/**
 * POST /api/digest
 *
 * Sends the weekly founder digest email.
 * Scheduled after /api/themes (Monday 07:00 UTC).
 *
 * Vercel Cron:
 *   { "path": "/api/digest", "schedule": "0 7 * * 1" }
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminClient();

  const weekOf = new Date();
  weekOf.setDate(weekOf.getDate() - weekOf.getDay() + 1);
  weekOf.setHours(0, 0, 0, 0);
  const weekOfStr = weekOf.toISOString().split('T')[0];

  // Orgs with themes this week
  const { data: themes } = await db
    .from('themes')
    .select('org_id, label, response_count, representative_quotes, mrr_impact')
    .eq('week_of', weekOfStr)
    .order('response_count', { ascending: false });

  if (!themes || themes.length === 0) {
    return NextResponse.json({ sent: 0 });
  }

  // Group themes by org
  const byOrg = themes.reduce<Record<string, typeof themes>>((acc, t) => {
    acc[t.org_id] = acc[t.org_id] ?? [];
    acc[t.org_id].push(t);
    return acc;
  }, {});

  const orgIds = Object.keys(byOrg);

  const { data: orgs } = await db
    .from('organizations')
    .select('id, name')
    .in('id', orgIds);

  // For each org, fetch total MRR lost and response count this week
  let sent = 0;

  for (const org of orgs ?? []) {
    const { data: founderUser } = await db
      .from('users')
      .select('email, name')
      .eq('org_id', org.id)
      .eq('role', 'owner')
      .single();

    if (!founderUser?.email) continue;

    const orgThemes = (byOrg[org.id] ?? []).slice(0, 3);

    const { count: totalResponses } = await db
      .from('survey_responses')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', org.id)
      .gte('surveyed_at', weekOf.toISOString());

    const { data: mrrRows } = await db
      .from('survey_responses')
      .select('mrr_lost')
      .eq('org_id', org.id)
      .gte('surveyed_at', weekOf.toISOString());

    const totalMrr = (mrrRows ?? []).reduce((s, r) => s + (r.mrr_lost ?? 0), 0);

    const firstName = founderUser.name?.split(' ')[0] ?? 'there';
    const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`;

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
Manage preferences: ${dashboardUrl}/settings`;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: founderUser.email,
      subject: `ChurnLens weekly: ${orgThemes[0]?.label ?? 'churn themes'} + ${totalResponses ?? 0} cancellations`,
      text: body,
    });

    sent++;
  }

  return NextResponse.json({ sent });
}
