import { NextResponse } from 'next/server';
import { query, queryOne, queryCount, execute } from '@/lib/db';
import { getResend, FROM_EMAIL } from '@/lib/resend';
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

  // At-most-once-per-week guard so a duplicate fire can't double-email founders.
  const claimed = await execute(
    `INSERT INTO cron_runs (job, week_of) VALUES ('digest', $1)
     ON CONFLICT (job, week_of) DO NOTHING`,
    [weekOfStr],
  );
  if (claimed === 0) {
    return NextResponse.json({ sent: 0, skipped: 'already_ran', weekOf: weekOfStr });
  }

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
      `SELECT COUNT(*) FROM survey_responses WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3`,
      [org.id, startIso, endIso],
    );

    const mrrRows = await query<{ mrr_lost: number }>(
      `SELECT mrr_lost FROM survey_responses WHERE org_id = $1 AND surveyed_at >= $2 AND surveyed_at < $3`,
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

    await getResend().emails.send({
      from: FROM_EMAIL,
      to: founderUser.email,
      subject: `ChurnLens weekly: ${orgThemes[0]?.label ?? 'churn themes'} + ${totalResponses ?? 0} cancellations`,
      text: body,
    });

    sent++;
  }

  return NextResponse.json({ sent });
}

// Vercel Cron issues GET requests; alias to the same handler. Safe to expose as
// GET because it is CRON_SECRET-gated and idempotent (cron_runs guard).
export const GET = POST;
