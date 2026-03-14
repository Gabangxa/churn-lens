import { NextResponse } from 'next/server';
import { query, queryOne, queryCount } from '@/lib/db';
import { resend, FROM_EMAIL } from '@/lib/resend';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const weekOf = new Date();
  weekOf.setDate(weekOf.getDate() - weekOf.getDay() + 1);
  weekOf.setHours(0, 0, 0, 0);
  const weekOfStr = weekOf.toISOString().split('T')[0];

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
    return NextResponse.json({ sent: 0 });
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

  let sent = 0;

  for (const org of orgs) {
    const founderUser = await queryOne<{ email: string; name: string | null }>(
      `SELECT email, name FROM users WHERE org_id = $1 AND role = 'owner' LIMIT 1`,
      [org.id],
    );

    if (!founderUser?.email) continue;

    const orgThemes = (byOrg[org.id] ?? []).slice(0, 3);

    const totalResponses = await queryCount(
      `SELECT COUNT(*) FROM survey_responses WHERE org_id = $1 AND surveyed_at >= $2`,
      [org.id, weekOf.toISOString()],
    );

    const mrrRows = await query<{ mrr_lost: number }>(
      `SELECT mrr_lost FROM survey_responses WHERE org_id = $1 AND surveyed_at >= $2`,
      [org.id, weekOf.toISOString()],
    );

    const totalMrr = mrrRows.reduce((s, r) => s + (r.mrr_lost ?? 0), 0);

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
