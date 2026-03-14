import type { SurveyResponse, Theme } from '@/lib/supabase';

// --- Stub data for the mockup ---
const STUB_THEMES: Theme[] = [
  {
    id: '1',
    org_id: 'demo',
    week_of: '2026-03-09',
    label: 'Too expensive for stage',
    response_count: 6,
    representative_quotes: [
      "I'm pre-revenue, $29 is hard to justify right now.",
      "Great product but I'm bootstrapped and cutting costs.",
    ],
    mrr_impact: 174,
    created_at: '2026-03-10T07:00:00Z',
  },
  {
    id: '2',
    org_id: 'demo',
    week_of: '2026-03-09',
    label: 'Missing Slack integration',
    response_count: 4,
    representative_quotes: [
      "I need alerts in Slack — email digest I don't check daily.",
    ],
    mrr_impact: 116,
    created_at: '2026-03-10T07:00:00Z',
  },
  {
    id: '3',
    org_id: 'demo',
    week_of: '2026-03-09',
    label: 'Switched to Churnkey',
    response_count: 2,
    representative_quotes: [
      "My co-founder was already using Churnkey before I joined.",
    ],
    mrr_impact: 58,
    created_at: '2026-03-10T07:00:00Z',
  },
];

const STUB_RESPONSES: SurveyResponse[] = [
  {
    id: 'r1',
    org_id: 'demo',
    customer_email: 'j***@gmail.com',
    customer_name: 'Jamie',
    stripe_subscription_id: 'sub_abc',
    mrr_lost: 29,
    reason_category: 'Too expensive for my budget',
    open_text: "I'm pre-revenue, $29 is hard to justify right now.",
    comeback_text: 'A free tier with more than 10 cancellations/mo.',
    theme_tags: ['Too expensive for stage'],
    surveyed_at: '2026-03-13T14:22:00Z',
  },
  {
    id: 'r2',
    org_id: 'demo',
    customer_email: 's***@co.io',
    customer_name: 'Sam',
    stripe_subscription_id: 'sub_def',
    mrr_lost: 29,
    reason_category: 'Missing a feature I need',
    open_text: "I need alerts in Slack — email digest I don't check daily.",
    comeback_text: 'Slack integration.',
    theme_tags: ['Missing Slack integration'],
    surveyed_at: '2026-03-12T09:11:00Z',
  },
  {
    id: 'r3',
    org_id: 'demo',
    customer_email: 'a***@startup.com',
    customer_name: null,
    stripe_subscription_id: 'sub_ghi',
    mrr_lost: 29,
    reason_category: 'Switched to a competitor',
    open_text: 'My co-founder was already using Churnkey before I joined.',
    comeback_text: null,
    theme_tags: ['Switched to Churnkey'],
    surveyed_at: '2026-03-11T16:45:00Z',
  },
  {
    id: 'r4',
    org_id: 'demo',
    customer_email: 'k***@indiehacker.io',
    customer_name: 'Kerry',
    stripe_subscription_id: 'sub_jkl',
    mrr_lost: 29,
    reason_category: 'Too expensive for my budget',
    open_text: 'Great product but I\'m bootstrapped and cutting costs.',
    comeback_text: null,
    theme_tags: ['Too expensive for stage'],
    surveyed_at: '2026-03-10T11:03:00Z',
  },
];

const THEME_COLORS: Record<string, string> = {
  'Too expensive for stage': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  'Missing Slack integration': 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  'Switched to Churnkey': 'bg-purple-500/15 text-purple-300 border-purple-500/30',
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

export default function DashboardPage() {
  const totalMrrLost = STUB_THEMES.reduce((acc, t) => acc + t.mrr_impact, 0);
  const totalResponses = STUB_RESPONSES.length;

  return (
    <div className="min-h-screen">
      {/* Dashboard nav */}
      <nav className="sticky top-0 z-40 border-b border-surface-700 bg-surface-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold tracking-tight">
            Churn<span className="text-brand-400">Lens</span>
          </span>
          <div className="flex items-center gap-4 text-sm text-muted">
            <span>Week of Mar 9</span>
            <span className="h-4 w-px bg-surface-600" />
            <span className="text-brand-400 font-medium">Starter plan</span>
            <span className="h-4 w-px bg-surface-600" />
            <a href="/settings" className="hover:text-zinc-100 transition-colors">Settings</a>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-10 space-y-8">

        {/* Stat bar */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Responses this week', value: totalResponses, unit: '' },
            { label: 'MRR lost', value: `$${totalMrrLost}`, unit: '' },
            { label: 'Survey response rate', value: '58', unit: '%' },
          ].map((stat) => (
            <div key={stat.label} className="card text-center">
              <p className="text-3xl font-bold text-zinc-50">
                {stat.value}{stat.unit}
              </p>
              <p className="mt-1 text-xs text-muted">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Theme summary card */}
        <div className="card">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                Themes this week
              </h2>
              <p className="text-xs text-muted mt-0.5">
                AI-synthesised from {totalResponses} responses — week of Mar 9
              </p>
            </div>
            <span className="rounded-full bg-brand-500/15 px-3 py-1 text-xs font-medium text-brand-300 border border-brand-500/30">
              AI summary
            </span>
          </div>

          <div className="space-y-4">
            {STUB_THEMES.map((theme, i) => (
              <div key={theme.id} className="rounded-lg bg-surface-700/50 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-xs text-muted">#{i + 1}</span>
                      <span className="font-medium text-zinc-100">{theme.label}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${THEME_COLORS[theme.label] ?? 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'}`}>
                        {theme.response_count} responses
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
        </div>

        {/* Response table */}
        <div className="card overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-surface-700 px-6 py-4">
            <h2 className="text-base font-semibold text-zinc-100">
              All responses
            </h2>
            <button className="rounded-lg border border-surface-600 px-3 py-1.5 text-xs text-muted hover:border-surface-500 hover:text-zinc-100 transition-colors">
              Export CSV
            </button>
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
                {STUB_RESPONSES.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-700/40 transition-colors">
                    <td className="px-6 py-4 text-zinc-300">
                      {r.customer_name ?? 'Anonymous'}
                      <br />
                      <span className="text-xs text-muted">{r.customer_email}</span>
                    </td>
                    <td className="px-6 py-4 text-zinc-300 max-w-[160px]">
                      <span className="line-clamp-2">{r.reason_category}</span>
                    </td>
                    <td className="px-6 py-4 text-zinc-400 max-w-[220px]">
                      <span className="line-clamp-2 text-xs italic">
                        {r.open_text ?? '—'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {r.theme_tags.map((tag) => (
                          <span
                            key={tag}
                            className={`rounded-full border px-2 py-0.5 text-xs ${THEME_COLORS[tag] ?? 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'}`}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-zinc-200">
                      ${r.mrr_lost}
                    </td>
                    <td className="px-6 py-4 text-right text-muted text-xs">
                      {fmt(r.surveyed_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
