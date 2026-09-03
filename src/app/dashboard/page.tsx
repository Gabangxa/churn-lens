import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOrgIdFromCookieStore } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import type { Theme, SurveyResponse } from '@/lib/db';
import Wordmark from '@/components/Wordmark';
import ThemeToggle from '@/components/ThemeToggle';

// Audit fixes: stat cards labelled by timeframe (this week vs all time);
// theme badge colours hashed from the label (stable week over week) instead
// of positional; marketing subhead replaced with a status line; log out link.

const PALETTE = [
  'bg-teal-400/10 text-teal-700 dark:text-teal-300 border-teal-400/30',
  'bg-emerald-400/10 text-emerald-700 dark:text-emerald-400 border-emerald-400/30',
  'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/30',
  'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/30',
  'bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30',
];

// Stable colour per label: same theme keeps its colour across weeks.
function themeColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

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

async function getDashboardData(orgId: string) {
  // Same test /api/settings/status uses, so the dashboard status line and the
  // settings page can never disagree about whether Stripe is connected.
  const org = await queryOne<{ stripe_api_key_enc: string | null; stripe_account_id: string | null }>(
    'SELECT stripe_api_key_enc, stripe_account_id FROM organizations WHERE id = $1',
    [orgId],
  );
  const stripeConnected = !!(org?.stripe_api_key_enc || org?.stripe_account_id);

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

  const responses = await query<SurveyResponse>(
    `SELECT * FROM survey_responses
     WHERE org_id = $1 AND surveyed_at IS NOT NULL
     ORDER BY surveyed_at DESC
     LIMIT 50`,
    [orgId],
  );

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
  const weekResponses = themes.reduce((acc, t) => acc + t.response_count, 0);
  const pending = totalSent - responded;

  return { themes, responses, latestWeek: latestWeek?.week_of ?? null, totalSent, responded, mrrLost, responseRate, weekMrr, weekResponses, pending, stripeConnected };
}

export default async function DashboardPage() {
  const orgId = getOrgIdFromCookieStore(cookies());
  // Not /onboarding: onboarding now requires a session too (it no longer
  // creates one), so an unauthenticated visitor goes to /login, which carries
  // them back here once they've signed in or signed up.
  if (!orgId) redirect('/login?next=/dashboard');

  const { themes, responses, latestWeek, totalSent, responded, mrrLost, responseRate, weekMrr, weekResponses, pending, stripeConnected } =
    await getDashboardData(orgId);

  const hasAnyData = totalSent > 0 || responses.length > 0;
  const hasThemes = themes.length > 0;

  // Timeframe-labelled stat cards. "This week" figures come from the latest
  // themes week; all-time figures from the responses table.
  const statCards = [
    { period: 'This week', highlight: hasThemes, value: hasThemes ? weekResponses.toString() : '—', label: 'responses themed' },
    { period: 'This week', highlight: hasThemes, value: hasThemes ? `$${weekMrr}` : '—', label: 'MRR lost' },
    { period: 'All time', highlight: false, value: `${responseRate}%`, label: `response rate · ${responded} of ${totalSent}` },
    { period: 'All time', highlight: false, value: totalSent.toString(), label: 'surveys sent' },
  ];

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
              className="font-bold text-sm tracking-wide text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
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
            {/* A form, not a link: /api/auth/logout is POST-only so a
                third-party page cannot force a logout with a GET. */}
            <form action="/api/auth/logout" method="POST" className="contents">
              <button
                type="submit"
                className="text-sm font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 px-8 md:px-12 pb-12 space-y-10 max-w-6xl w-full mx-auto">
        {/* Header — status line instead of marketing prose */}
        <div className="pt-4 pb-2">
          <h1 className="text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white mb-3 transition-colors duration-500">
            Dashboard
          </h1>
          {stripeConnected ? (
            <p className="text-sm font-medium text-muted">
              <span className="font-bold text-emerald-600 dark:text-emerald-400">●</span>{' '}
              Stripe connected · surveys firing automatically
            </p>
          ) : (
            <p className="text-sm font-medium text-muted">
              <span className="font-bold text-amber-600 dark:text-amber-400">●</span>{' '}
              Stripe not connected — no surveys will send.{' '}
              <Link href="/settings" className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-white">
                Connect it in settings
              </Link>
            </p>
          )}
        </div>

        {/* ── Empty state ── */}
        {!hasAnyData && (
          <div className="card flex flex-col items-center py-16 text-center">
            <div className="mb-6 h-16 w-16 rounded-full border-4 border-dashed border-teal-400/60 transition-colors duration-500" />
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
            {/* Stat cards — labelled by timeframe */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
              {statCards.map((stat) => (
                <div key={stat.period + stat.label} className="card">
                  <p className={`mb-3 text-[10px] font-bold uppercase tracking-wider ${stat.highlight ? 'text-teal-700 dark:text-teal-300' : 'text-muted'}`}>
                    {stat.period}
                  </p>
                  <p className="text-3xl md:text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
                    {stat.value}
                  </p>
                  <p className="mt-1 text-xs font-medium text-muted">{stat.label}</p>
                </div>
              ))}
            </div>

            {/* ── Themes ── */}
            <div className="card">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold font-display text-zinc-900 dark:text-white transition-colors duration-500">
                    {hasThemes ? 'Themes this week' : 'Themes'}
                  </h2>
                  <p className="mt-1 text-sm font-medium text-muted">
                    {hasThemes
                      ? `AI-synthesised from ${weekResponses} responses — week of ${fmtWeek(latestWeek!)}`
                      : pending > 0
                        ? `${pending} response${pending !== 1 ? 's' : ''} pending — themes generate Monday 06:00 UTC`
                        : 'Themes will appear here after the first Monday digest run'}
                  </p>
                </div>
                {hasThemes && (
                  <span className="rounded-full bg-teal-700 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white">
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
                            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${themeColor(theme.label)}`}>
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
                          <p className="text-lg font-extrabold font-display text-zinc-900 dark:text-white">${theme.mrr_impact}</p>
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
                  {responses.length === 50 && (
                    <span className="text-xs font-medium text-muted">Showing latest 50</span>
                  )}
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
                              <span className="ml-2 rounded-full border border-indigo-400/40 bg-indigo-400/10 px-2 py-0.5 text-xs font-bold text-indigo-700 dark:text-indigo-300">
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
                                      className={`rounded-full border px-2 py-0.5 text-xs font-bold ${themeColor(tag)}`}
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
