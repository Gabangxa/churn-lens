import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOrgIdFromCookieStore } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import type { Theme, SurveyResponse } from '@/lib/db';
import Wordmark from '@/components/Wordmark';
import ThemeToggle from '@/components/ThemeToggle';

// Colour palette for theme badges — assigned by position, not by label.
const PALETTE = [
  'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  'bg-teal-400/10 text-teal-600 dark:text-teal-300 border-teal-400/30',
  'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  'bg-yellow-300/20 text-yellow-700 dark:text-yellow-300 border-yellow-400/40',
  'bg-emerald-400/10 text-emerald-600 dark:text-emerald-400 border-emerald-400/30',
];

// Corner-blob accents for the stat cards, cycled by position.
const STAT_ACCENTS = ['bg-pink-500', 'bg-teal-400', 'bg-blue-500'];

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

  // Stats — test surveys are shown in the table but never counted here.
  const stats = await queryOne<{ total_sent: string; responded: string; mrr_lost: string }>(
    `SELECT
       COUNT(*) AS total_sent,
       COUNT(*) FILTER (WHERE surveyed_at IS NOT NULL) AS responded,
       COALESCE(SUM(mrr_lost) FILTER (WHERE surveyed_at IS NOT NULL), 0) AS mrr_lost
     FROM survey_responses
     WHERE org_id = $1 AND NOT is_test`,
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

  // Test responses don't count toward stats but must still surface in the table,
  // otherwise a founder's test survey would land in an invisible dashboard.
  const hasAnyData = totalSent > 0 || responses.length > 0;
  const hasThemes = themes.length > 0;

  // Build a label → colour map from the current week's themes
  const themeColorMap: Record<string, string> = {};
  themes.forEach((t, i) => {
    themeColorMap[t.label] = PALETTE[i % PALETTE.length];
  });

  return (
    <div className="flex flex-col min-h-full">
      {/* Nav */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-[#09090b]/90 backdrop-blur transition-colors duration-500">
        <div className="flex items-center justify-between px-8 md:px-12 py-6">
          <Wordmark />
          <nav className="hidden md:flex items-center space-x-10">
            <span className="font-bold text-sm tracking-wide text-zinc-900 dark:text-white">Dashboard</span>
            <Link
              href="/settings"
              className="font-bold text-sm tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 transition-colors"
            >
              Settings
            </Link>
          </nav>
          <div className="flex items-center space-x-4">
            {latestWeek && (
              <span className="hidden md:inline text-xs font-bold uppercase tracking-wider text-muted">
                Week of {fmtWeek(latestWeek)}
              </span>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 px-8 md:px-12 pb-12 space-y-10 max-w-6xl w-full mx-auto">
        {/* Header */}
        <div className="pt-4 pb-2">
          <h1 className="text-5xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white mb-4 transition-colors duration-500">
            Dashboard
          </h1>
          <p className="text-lg text-zinc-500 dark:text-zinc-400 max-w-2xl font-medium leading-relaxed transition-colors duration-500">
            Deconstruct why users leave. AI analyzes exit surveys to help you
            piece together the perfect retention strategy.
          </p>
        </div>

        {/* ── Empty state: no activity yet ── */}
        {!hasAnyData && (
          <div className="card flex flex-col items-center py-16 text-center">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-yellow-300 dark:bg-yellow-300/20 shadow-xl shadow-yellow-300/30 dark:shadow-none transform -rotate-6 transition-colors duration-500">
              <span className="text-3xl">⏳</span>
            </div>
            <h2 className="text-2xl font-bold font-display text-zinc-900 dark:text-zinc-100">
              Waiting for your first cancellation
            </h2>
            <p className="mt-3 max-w-sm text-sm font-medium text-muted leading-relaxed">
              ChurnLens is active. When a customer cancels, they{"'"}ll receive a
              survey and their response will appear here.
            </p>
          </div>
        )}

        {/* ── Has activity ── */}
        {hasAnyData && (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                { label: 'Surveys sent (all time)', value: totalSent.toString() },
                { label: 'All-time MRR lost surveyed', value: `$${mrrLost}` },
                { label: 'Survey response rate', value: `${responseRate}%` },
              ].map((stat, i) => (
                <div
                  key={stat.label}
                  className="card group relative overflow-hidden hover:-translate-y-1 transition-all duration-300"
                >
                  <div
                    className={`absolute -right-6 -top-6 w-24 h-24 rounded-full opacity-20 dark:opacity-10 group-hover:scale-150 transition-transform duration-500 ${STAT_ACCENTS[i % STAT_ACCENTS.length]}`}
                  />
                  <p className="relative z-10 mb-3 text-sm font-bold uppercase tracking-wider text-muted">
                    {stat.label}
                  </p>
                  <p className="relative z-10 text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            {/* ── Themes section ── */}
            <div className="card">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold font-display text-zinc-900 dark:text-white transition-colors duration-500">
                    {hasThemes ? 'Themes this week' : 'Themes'}
                  </h2>
                  <p className="mt-1 text-sm font-medium text-muted">
                    {hasThemes
                      ? `AI-synthesised from ${themes.reduce((a, t) => a + t.response_count, 0)} responses — week of ${fmtWeek(latestWeek!)}`
                      : pending > 0
                        ? `${pending} response${pending !== 1 ? 's' : ''} pending — themes generate Monday 06:00 UTC`
                        : 'Themes will appear here after the first Monday digest run'}
                  </p>
                </div>
                {hasThemes && (
                  <span className="rounded-full bg-pink-500 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white">
                    AI summary
                  </span>
                )}
              </div>

              {hasThemes ? (
                <div className="space-y-4">
                  {themes.map((theme, i) => (
                    <div
                      key={theme.id}
                      className="p-5 bg-white dark:bg-[#18181b] rounded-2xl shadow-sm dark:shadow-none border border-zinc-100 dark:border-zinc-800 hover:border-zinc-200 dark:hover:border-zinc-700 hover:shadow-md transition-all duration-300"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="mb-2 flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-muted">#{i + 1}</span>
                            <span className="font-bold text-zinc-900 dark:text-zinc-100">{theme.label}</span>
                            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${PALETTE[i % PALETTE.length]}`}>
                              {theme.response_count} response{theme.response_count !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="space-y-1">
                            {theme.representative_quotes.map((q) => (
                              <p
                                key={q}
                                className="text-sm font-medium text-zinc-500 dark:text-zinc-400 italic before:content-['“'] after:content-['”']"
                              >
                                {q}
                              </p>
                            ))}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-lg font-extrabold text-pink-500 dark:text-pink-400">${theme.mrr_impact}</p>
                          <p className="text-xs font-bold uppercase tracking-wider text-muted">MRR impact</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 py-10 text-center text-sm font-medium text-muted">
                  {weekMrr === 0 && responded === 0
                    ? 'No completed responses yet — check back after your first surveys are submitted.'
                    : `${responded} completed response${responded !== 1 ? 's' : ''} collected. Themes will be generated on the next Monday run.`}
                </div>
              )}
            </div>

            {/* ── Response table ── */}
            {responses.length > 0 && (
              <div className="bg-white dark:bg-[#121214] rounded-3xl border border-zinc-100 dark:border-zinc-800 overflow-hidden shadow-sm dark:shadow-none transition-colors duration-500">
                <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 px-8 py-6 transition-colors duration-500">
                  <h2 className="text-2xl font-bold font-display text-zinc-900 dark:text-white transition-colors duration-500">
                    All responses
                    <span className="ml-3 text-sm font-medium font-sans text-muted">({responded} total)</span>
                  </h2>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-100 dark:border-zinc-800 text-xs font-bold text-muted uppercase tracking-wider">
                        <th className="px-8 py-4 text-left">Customer</th>
                        <th className="px-6 py-4 text-left">Reason</th>
                        <th className="px-6 py-4 text-left">Open text</th>
                        <th className="px-6 py-4 text-left">Themes</th>
                        <th className="px-6 py-4 text-right">MRR lost</th>
                        <th className="px-8 py-4 text-right">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {responses.map((r) => (
                        <tr key={r.id} className="hover:bg-[#f8f9fa] dark:hover:bg-[#18181b] transition-colors">
                          <td className="px-8 py-4 font-medium text-zinc-700 dark:text-zinc-300">
                            {r.customer_name ?? 'Anonymous'}
                            {r.is_test && (
                              <span className="ml-2 rounded-full border border-yellow-400/40 bg-yellow-300/20 px-2 py-0.5 text-xs font-bold text-yellow-700 dark:text-yellow-300">
                                Test
                              </span>
                            )}
                            <br />
                            <span className="text-xs font-normal text-muted">{maskEmail(r.customer_email)}</span>
                          </td>
                          <td className="max-w-[160px] px-6 py-4 font-medium text-zinc-700 dark:text-zinc-300">
                            <span className="line-clamp-2">{r.reason_category ?? '—'}</span>
                          </td>
                          <td className="max-w-[220px] px-6 py-4 text-zinc-500 dark:text-zinc-400">
                            <span className="line-clamp-2 text-xs italic">{r.open_text ?? '—'}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-1">
                              {r.theme_tags.length > 0
                                ? r.theme_tags.map((tag) => (
                                    <span
                                      key={tag}
                                      className={`rounded-full border px-2 py-0.5 text-xs font-bold ${themeColorMap[tag] ?? 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-500/30'}`}
                                    >
                                      {tag}
                                    </span>
                                  ))
                                : <span className="text-xs text-muted">—</span>}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right font-mono font-medium text-zinc-800 dark:text-zinc-200">${r.mrr_lost}</td>
                          <td className="px-8 py-4 text-right text-xs font-medium text-muted">{fmt(r.surveyed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
