import Link from 'next/link';
import Wordmark from '@/components/Wordmark';
import SiteHeader from '@/components/SiteHeader';

const FEATURES = [
  {
    shape: 'rounded-lg -rotate-6 bg-emerald-400 dark:bg-emerald-400/30',
    title: 'Stripe-native',
    description:
      'Connect once. Every cancellation triggers an exit survey automatically — no code, no Zapier.',
  },
  {
    shape: 'rounded-full bg-teal-500 dark:bg-teal-400/30',
    title: 'AI theme synthesis',
    description:
      'AI clusters responses nightly into plain-English themes. Stop reading raw text; start reading patterns.',
  },
  {
    shape: 'rounded-lg rotate-45 scale-90 bg-cyan-600 dark:bg-cyan-500/30',
    title: 'Weekly founder digest',
    description:
      '"Top 3 reasons customers left this week" — delivered Monday morning like a smart co-founder\'s report.',
  },
];

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    period: '',
    description: 'Try it on real cancellations.',
    limit: 'Up to 10 cancellations/mo',
    features: ['Stripe webhook', '3-question survey', 'Response dashboard'],
    cta: 'Start free',
    href: '/login',
    highlight: false,
  },
  {
    name: 'Starter',
    price: '$29',
    period: '/mo',
    description: 'Everything you need when MRR matters.',
    limit: 'Up to 100 cancellations/mo',
    features: [
      'Everything in Free',
      'AI theme clustering',
      'Weekly digest email',
      'MRR impact tracking',
    ],
    cta: 'Start 14-day trial',
    href: '/login?plan=starter',
    highlight: true,
  },
  {
    name: 'Growth',
    price: '$79',
    period: '/mo',
    description: 'For when churn is a full-time problem.',
    limit: 'Unlimited cancellations',
    features: [
      'Everything in Starter',
      'Slack integration',
      'CSV export',
      'Custom survey questions',
    ],
    cta: 'Start 14-day trial',
    href: '/login?plan=growth',
    highlight: false,
  },
];

const COMPETITORS = [
  { name: 'Churnkey', price: '$250/mo' },
  { name: 'Baremetrics add-on', price: '$129/mo' },
  { name: 'Raaft', price: '$79/mo' },
];

// Static mockup of the Monday digest — the product itself, shown in the hero.
function DigestPreview() {
  return (
    <div>
      <div className="rounded-2xl bg-teal-950 p-5 shadow-[10px_10px_0px_0px_#34d399] dark:shadow-[10px_10px_0px_0px_rgba(52,211,153,0.6)]">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-7 py-6 font-sans">
          <p className="m-0 text-[15px] font-semibold tracking-tight text-zinc-100">
            Churn<span className="text-emerald-400">Lens</span>
          </p>
          <p className="mb-0 mt-4 text-lg font-bold text-zinc-50">Your weekly digest</p>
          <p className="m-0 text-xs text-zinc-400">Week of 2026-03-09</p>
          <div className="mt-4 rounded-lg bg-zinc-800 px-3.5 py-2.5 text-[13px] text-zinc-400">
            <strong className="text-zinc-100">12</strong> cancellations this week &nbsp;·&nbsp;{' '}
            <strong className="text-zinc-100">$348</strong> MRR lost
          </div>
          <p className="mb-0 mt-5 text-[10px] font-semibold tracking-wider text-zinc-400">
            TOP REASONS CUSTOMERS LEFT
          </p>
          <div className="mt-1.5 space-y-3.5 border-t border-zinc-800 pt-3.5">
            {[
              { rank: '#1', label: 'Too expensive for stage', meta: '(6 responses, $174 MRR)', quote: '"I\'m pre-revenue, $29 is hard to justify right now."' },
              { rank: '#2', label: 'Missing Slack integration', meta: '(4 responses, $116 MRR)', quote: '"I need alerts in Slack — email digest I don\'t check daily."' },
              { rank: '#3', label: 'Switched to Churnkey', meta: '(2 responses, $58 MRR)', quote: null },
            ].map((t) => (
              <div key={t.rank}>
                <p className="m-0 text-[13px] text-zinc-300">
                  <span className="text-zinc-400">{t.rank}</span>{' '}
                  <strong className="text-zinc-100">{t.label}</strong>{' '}
                  <span className="text-zinc-400">{t.meta}</span>
                </p>
                {t.quote && (
                  <p className="mb-0 mt-1 border-l-[3px] border-emerald-400 pl-2.5 text-xs italic text-zinc-400">
                    {t.quote}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="mb-0 mt-4 border-t border-zinc-800 pt-3 text-xs text-emerald-400">
            View all responses in your dashboard &rarr;
          </p>
        </div>
      </div>
      <p className="mt-4 text-center font-mono text-xs font-medium text-muted">
        the Monday digest — this is the product
      </p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="flex flex-col min-h-full">
      <SiteHeader />

      {/* Hero */}
      <section className="grid items-center gap-14 px-8 py-16 md:grid-cols-[1.1fr_1fr] md:px-12 md:py-20">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#121214] px-5 py-2 text-sm font-bold text-zinc-600 dark:text-zinc-300 transition-colors duration-500">
            <span className="h-2 w-2 rounded-full bg-teal-600 dark:bg-teal-400 animate-pulse" />
            Built for founders at $500–$10K MRR
          </div>

          <h1 className="mt-8 max-w-5xl text-5xl sm:text-6xl md:text-7xl font-extrabold font-display leading-[1.02] tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
            Find out why customers{' '}
            <span className="text-emerald-600 dark:text-emerald-400">really</span> cancel
          </h1>

          <p className="mt-8 max-w-2xl text-lg md:text-xl text-zinc-500 dark:text-zinc-400 font-medium leading-relaxed transition-colors duration-500">
            When a Stripe subscription cancels, ChurnLens emails the customer a
            3-question exit survey within minutes — then AI turns the answers
            into plain-English themes, delivered every Monday.
          </p>

          <div className="mt-12 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <Link
              href="/login"
              className="px-10 py-4 rounded-full bg-teal-700 text-white font-extrabold uppercase tracking-widest text-sm shadow-[6px_6px_0px_0px_#134e4a] dark:shadow-[6px_6px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[6px] hover:translate-y-[6px] hover:bg-teal-800 transition-all"
            >
              Connect Stripe — it&apos;s free
            </Link>
            <a
              href="#pricing"
              className="px-10 py-4 rounded-full border-2 border-zinc-200 dark:border-zinc-700 font-bold uppercase tracking-widest text-sm text-zinc-600 dark:text-zinc-300 hover:border-zinc-900 dark:hover:border-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              See pricing
            </a>
          </div>

          <p className="mt-6 max-w-2xl text-sm font-medium text-muted">
            No credit card required. Your first survey fires on your next cancellation.
          </p>
        </div>

        <DigestPreview />
      </section>

      {/* Price comparison strip (replaces unverifiable social proof) */}
      <div className="border-y border-zinc-100 dark:border-zinc-800 bg-[#f8f9fa] dark:bg-[#121214] py-5 transition-colors duration-500">
        <p className="flex flex-wrap items-baseline justify-center gap-x-10 gap-y-1 px-6 text-center text-sm font-semibold text-muted">
          {COMPETITORS.map((c) => (
            <span key={c.name}>
              {c.name} <strong className="text-zinc-900 dark:text-zinc-200">{c.price}</strong>
            </span>
          ))}
          <span className="font-extrabold text-teal-700 dark:text-teal-300">ChurnLens $29/mo</span>
        </p>
      </div>

      {/* Features */}
      <section id="features" className="w-full px-8 md:px-12 py-24">
        <h2 className="text-4xl md:text-5xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Everything a solo founder needs. Nothing else.
        </h2>

        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="card group relative overflow-hidden hover:-translate-y-1 transition-all duration-300"
            >
              <div className={`relative z-10 mb-5 h-9 w-9 transition-colors duration-500 ${f.shape}`} />
              <h3 className="relative z-10 mb-2 text-xl font-bold font-display text-zinc-900 dark:text-zinc-100">
                {f.title}
              </h3>
              <p className="relative z-10 text-sm font-medium text-muted leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>

        {/* How it works */}
        <div className="mt-24">
          <h2 className="text-4xl md:text-5xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
            How it works
          </h2>
          <div className="mt-14 grid gap-8 sm:grid-cols-3">
            {[
              {
                step: '01',
                color: 'text-teal-700 dark:text-teal-300',
                title: 'Connect Stripe',
                body: 'OAuth or a restricted API key. Takes 60 seconds — ChurnLens registers a webhook and is live immediately.',
              },
              {
                step: '02',
                color: 'text-emerald-600 dark:text-emerald-400',
                title: 'Customer cancels',
                body: 'We catch the webhook and send a respectful 3-question survey to the churned customer within minutes.',
              },
              {
                step: '03',
                color: 'text-cyan-700 dark:text-cyan-400',
                title: 'You get clarity',
                body: 'Every Monday: top themes, representative quotes, MRR impact — one clean email. Dig into every response in the dashboard whenever you want.',
              },
            ].map((item) => (
              <div key={item.step} className="flex gap-5">
                <span className={`font-mono text-3xl font-bold leading-none ${item.color}`}>
                  {item.step}
                </span>
                <div>
                  <h3 className="mb-1.5 text-lg font-bold font-display text-zinc-900 dark:text-zinc-100">{item.title}</h3>
                  <p className="text-sm font-medium text-muted leading-relaxed">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="bg-[#f8f9fa] dark:bg-[#121214] py-24 transition-colors duration-500">
        <div className="w-full px-8 md:px-12">
          <h2 className="text-4xl md:text-5xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
            Indie-founder pricing
          </h2>
          <p className="mt-4 max-w-md font-medium text-muted">
            No per-seat fees. No enterprise add-ons. Cancel anytime. Trials don&apos;t need a card.
          </p>

          {/* Lifetime deal — announcement only. No claim CTA until billing is
              wired (Polar.sh): the onboarding route has nowhere to record a
              lifetime claim, so a claim button would take the click and drop it. */}
          <div className="mt-10 rounded-3xl border-2 border-emerald-400 bg-emerald-400/15 dark:bg-emerald-400/10 p-5 transition-colors duration-500">
            <p className="m-0 text-sm font-bold text-emerald-900 dark:text-emerald-300">
              <span className="mr-2 rounded-full bg-emerald-400 px-2.5 py-0.5 font-mono text-[10px] font-bold text-teal-950">LAUNCH</span>
              Lifetime deal — Starter tier forever for a one-time $299. Product Hunt launch window only.
            </p>
          </div>

          <div className="mt-14 grid gap-6 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`flex flex-col rounded-3xl p-8 bg-white dark:bg-[#09090b] transition-all duration-300 ${
                  plan.highlight
                    ? 'border-2 border-teal-900 dark:border-teal-100 shadow-[8px_8px_0px_0px_#34d399]'
                    : 'border border-zinc-100 dark:border-zinc-800 hover:-translate-y-1'
                }`}
              >
                {plan.highlight && (
                  <div className="mb-4 self-start rounded-full bg-teal-700 px-4 py-1 text-xs font-bold uppercase tracking-widest text-white">
                    Most popular
                  </div>
                )}
                <div className="mb-1 text-lg font-bold font-display text-zinc-900 dark:text-zinc-100">
                  {plan.name}
                </div>
                <div className="mb-1 flex items-end gap-1">
                  <span className="text-5xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white">
                    {plan.price}
                  </span>
                  <span className="mb-1.5 font-medium text-muted">{plan.period}</span>
                </div>
                <p className="mb-3 text-sm font-medium text-muted">{plan.description}</p>
                <p className="mb-5 text-xs font-bold uppercase tracking-wider text-teal-700 dark:text-teal-300">
                  {plan.limit}
                </p>
                <ul className="mb-8 flex-1 space-y-2.5">
                  {plan.features.map((feat) => (
                    <li key={feat} className="flex items-start gap-2 text-sm font-medium text-zinc-600 dark:text-zinc-300">
                      <span className="mt-0.5 font-bold text-emerald-600 dark:text-emerald-400">✓</span>
                      {feat}
                    </li>
                  ))}
                </ul>
                <Link
                  href={plan.href}
                  className={`mt-auto rounded-full px-6 py-3 text-center text-xs font-bold uppercase tracking-widest transition-all ${
                    plan.highlight
                      ? 'bg-teal-700 text-white shadow-[4px_4px_0px_0px_#134e4a] dark:shadow-[4px_4px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px]'
                      : 'border-2 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-zinc-900 dark:hover:border-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                  }`}
                >
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA footer */}
      <section className="px-8 md:px-12 py-24">
        <h2 className="text-4xl md:text-5xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Stop guessing. Start listening.
        </h2>
        <p className="mt-4 max-w-2xl font-medium text-muted">
          Your next cancellation will tell you something. ChurnLens makes sure
          you actually hear it.
        </p>
        <Link
          href="/login"
          className="mt-10 inline-block px-10 py-4 rounded-full bg-teal-700 text-white font-extrabold uppercase tracking-widest text-sm shadow-[6px_6px_0px_0px_#134e4a] dark:shadow-[6px_6px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[6px] hover:translate-y-[6px] hover:bg-teal-800 transition-all"
        >
          Connect Stripe for free
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-100 dark:border-zinc-800 py-8 transition-colors duration-500">
        <div className="flex flex-col items-center justify-between gap-4 px-8 md:px-12 text-sm font-medium text-muted sm:flex-row">
          <span className="inline-flex items-center gap-2">
            <Wordmark size="sm" /> — built by a founder, for founders.
          </span>
          <div className="flex gap-6">
            <Link href="/legal/privacy" className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">Privacy</Link>
            <Link href="/legal/terms" className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">Terms</Link>
            <Link href="/legal/dpa" className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">DPA</Link>
            <a href="mailto:hello@churnlens.com" className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
