import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOrgIdFromCookieStore } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import type { Theme, SurveyResponse } from '@/lib/db';

// Colour palette for theme badges — assigned by position, not by label.
const PALETTE = [
  'bg-amber-500/15 text-amber-300 border-amber-500/30',
  'bg-teal-500/15 text-teal-300 border-teal-500/30',
  'bg-purple-500/15 text-purple-300 border-purple-500/30',
  'bg-blue-500/15 text-blue-300 border-blue-500/30',
  'bg-rose-500/15 text-rose-300 border-rose-500/30',
];

function maskEmail(email: string): string {
  return email.replace(/^(.{1,2})[^@]*@/, '$1***@');
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtWeek(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getDashboardData(orgId: string) {
  // Most recent week that has themes
  const latestWeek = await queryOne<{ week_of: string }>(
    'SELECT week_of FROM themes WHERE org_id = $1 ORDER BY week_of DESC LIMIT 1',
    [orgId],
  );

  const themes: Theme[] = latestWeek
    ? await query<Theme>(
        'SELECT * FROM themes WHERE org_id = $1 AND week_of = $2 ORDER BY response_count DESC',
        [orgId, latestWeek.week_of],
      )
    : [];

  // All completed responses, most recent first
  const responses = await query<SurveyResponse>(
    `SELECT * FROM survey_responses
     WHERE org_id = $1 AND surveyed_at IS NOT NULL
     ORDER BY surveyed_at DESC
     LIMIT 50`,
    [orgId],
  );

  // Stats
  const stats = await queryOne<{ total_sent: string; responded: string; mrr_lost: string }>(
    `SELECT
       COUNT(*) AS total_sent,
       COUNT(*) FILTER (WHERE surveyed_at IS NOT NULL) AS responded,
       COALESCE(SUM(mrr_lost) FILTER (WHERE surveyed_at IS NOT NULL), 0) AS mrr_lost
     FROM survey_responses
     WHERE org_id = $1`,
    [orgId],
  );

  const totalSent = parseInt(stats?.total_sent ?? '0', 10);
  const responded = parseInt(stats?.responded ?? '0', 10);
  const mrrLost = parseInt(stats?.mrr_lost ?? '0', 10);
  const responseRate = totalSent > 0 ? Math.round((responded / totalSent) * 100) : 0;
  const weekMrr = themes.reduce((acc, t) => acc + t.mrr_impact, 0);

  // Pending: surveys sent but not yet completed
  const pending = totalSent - responded;

  return { themes, responses, latestWeek: latestWeek?.week_of ?? null, totalSent, responded, mrrLost, responseRate, weekMrr, pending };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const orgId = getOrgIdFromCookieStore(cookies());
  if (!orgId) redirect('/onboarding');

  const { themes, responses, latestWeek, totalSent, responded, mrrLost, responseRate, weekMrr, pending } =
    await getDashboardData(orgId);

  const hasAnyData = totalSent > 0;
  const hasThemes = themes.length > 0;

  // Build a label → colour map from the current week's themes
  const themeColorMap: Record<string, string> = {};
  themes.forEach((t, i) => {
    themeColorMap[t.label] = PALETTE[i % PALETTE.length];
  });

  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-surface-700 bg-surface-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold tracking-tight">
            Churn<span className="text-brand-400">Lens</span>
          </span>
          <div className="flex items-center gap-4 text-sm text-muted">
            {latestWeek && (
              <>
                <span>Week of {fmtWeek(latestWeek)}</span>
                <span className="h-4 w-px bg-surface-600" />
              </>
            )}
            <a href="/settings" className="hover:text-zinc-100 transition-colors">Settings</a>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-10 space-y-8">

        {/* ── Empty state: no activity yet ── */}
        {!hasAnyData && (
          <div className="card flex flex-col items-center py-16 text-center">
            <div className="mb-4 h-12 w-12 rounded-full bg-brand-500/10 flex items-center justify-center">
              <svg className="h-6 w-6 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-zinc-100">Waiting for your first cancellation</h2>
            <p className="mt-2 max-w-sm text-sm text-muted leading-relaxed">
              ChurnLens is active. When a customer cancels, they{"'"}ll receive a survey and their response will appear here.
            </p>
          </div>
        )}

        {/* ── Has activity ── */}
        {hasAnyData && (
          <>
            {/* Stat bar */}
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: 'Surveys sent (all time)', value: totalSent.toString() },
                { label: 'All-time MRR lost surveyed', value: `$${mrrLost}` },
                { label: 'Survey response rate', value: `${responseRate}%` },
              ].map((stat) => (
                <div key={stat.label} className="card text-center">
                  <p className="text-3xl font-bold text-zinc-50">{stat.value}</p>
                  <p className="mt-1 text-xs text-muted">{stat.label}</p>
                </div>
              ))}
            </div>

            {/* ── Themes section ── */}
            <div className="card">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">
                    {hasThemes ? 'Themes this week' : 'Themes'}
                  </h2>
                  <p className="text-xs text-muted mt-0.5">
                    {hasThemes
                      ? `AI-synthesised from ${themes.reduce((a, t) => a + t.response_count, 0)} responses — week of ${fmtWeek(latestWeek!)}`
                      : pending > 0
                        ? `${pending} response${pending !== 1 ? 's' : ''} pending — themes generate Monday 06:00 UTC`
                        : 'Themes will appear here after the first Monday digest run'}
                  </p>
                </div>
                {hasThemes && (
                  <span className="rounded-full bg-brand-500/15 px-3 py-1 text-xs font-medium text-brand-300 border border-brand-500/30">
                    AI summary
                  </span>
                )}
              </div>

              {hasThemes ? (
                <div className="space-y-4">
                  {themes.map((theme, i) => (
                    <div key={theme.id} className="rounded-lg bg-surface-700/50 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="font-mono text-xs text-muted">#{i + 1}</span>
                            <span className="font-medium text-zinc-100">{theme.label}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-xs ${PALETTE[i % PALETTE.length]}`}>
                              {theme.response_count} response{theme.response_count !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="space-y-1">
                            {theme.representative_quotes.map((q) => (
                              <p key={q} className="text-sm text-zinc-400 italic before:content-['\u201c'] after:content-['\u201d']">
                                {q}
                              </p>
                            ))}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-lg font-semibold text-zinc-100">${theme.mrr_impact}</p>
                          <p className="text-xs text-muted">MRR impact</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-surface-600 py-10 text-center text-sm text-muted">
                  {weekMrr === 0 && responded === 0
                    ? 'No completed responses yet — check back after your first surveys are submitted.'
                    : `${responded} completed response${responded !== 1 ? 's' : ''} collected. Themes will be generated on the next Monday run.`}
                </div>
              )}
            </div>

            {/* ── Response table ── */}
            {responses.length > 0 && (
              <div className="card overflow-hidden p-0">
                <div className="flex items-center justify-between border-b border-surface-700 px-6 py-4">
                  <h2 className="text-base font-semibold text-zinc-100">
                    All responses
                    <span className="ml-2 text-xs font-normal text-muted">({responded} total)</span>
                  </h2>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-700 text-xs text-muted uppercase tracking-wider">
                        <th className="px-6 py-3 text-left font-medium">Customer</th>
                        <th className="px-6 py-3 text-left font-medium">Reason</th>
                        <th className="px-6 py-3 text-left font-medium">Open text</th>
                        <th className="px-6 py-3 text-left font-medium">Themes</th>
                        <th className="px-6 py-3 text-right font-medium">MRR lost</th>
                        <th className="px-6 py-3 text-right font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-700">
                      {responses.map((r) => (
                        <tr key={r.id} className="hover:bg-surface-700/40 transition-colors">
                          <td className="px-6 py-4 text-zinc-300">
                            {r.customer_name ?? 'Anonymous'}
                            <br />
                            <span className="text-xs text-muted">{maskEmail(r.customer_email)}</span>
                          </td>
                          <td className="px-6 py-4 text-zinc-300 max-w-[160px]">
                            <span className="line-clamp-2">{r.reason_category ?? '—'}</span>
                          </td>
                          <td className="px-6 py-4 text-zinc-400 max-w-[220px]">
                            <span className="line-clamp-2 text-xs italic">{r.open_text ?? '—'}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-1">
                              {r.theme_tags.length > 0
                                ? r.theme_tags.map((tag) => (
                                    <span
                                      key={tag}
                                      className={`rounded-full border px-2 py-0.5 text-xs ${themeColorMap[tag] ?? 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'}`}
                                    >
                                      {tag}
                                    </span>
                                  ))
                                : <span className="text-xs text-muted">—</span>}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right font-mono text-zinc-200">${r.mrr_lost}</td>
                          <td className="px-6 py-4 text-right text-muted text-xs">{fmt(r.surveyed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
