import Link from 'next/link';

const FEATURES = [
  {
    icon: '⚡',
    title: 'Stripe-native',
    description:
      'Connect once. Every cancellation triggers an exit survey automatically — no code, no Zapier.',
  },
  {
    icon: '🧠',
    title: 'AI theme synthesis',
    description:
      'GPT-4o-mini clusters responses nightly. Stop reading raw text; start reading patterns.',
  },
  {
    icon: '📬',
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
    ai: false,
    cta: 'Start free',
    href: '/onboarding',
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
    ai: true,
    cta: 'Start 14-day trial',
    href: '/onboarding?plan=starter',
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
    ai: true,
    cta: 'Start 14-day trial',
    href: '/onboarding?plan=growth',
    highlight: false,
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-surface-700 bg-surface-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold tracking-tight">
            Churn<span className="text-brand-400">Lens</span>
          </span>
          <div className="flex items-center gap-6">
            <a href="#features" className="text-sm text-muted hover:text-zinc-100 transition-colors">
              Features
            </a>
            <a href="#pricing" className="text-sm text-muted hover:text-zinc-100 transition-colors">
              Pricing
            </a>
            <Link
              href="/onboarding"
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors"
            >
              Get started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-6 py-28 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-4 py-1.5 text-sm text-brand-300">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-pulse" />
          Built for founders at $500–$10K MRR
        </div>

        <h1 className="mt-6 text-5xl font-bold leading-tight tracking-tight text-zinc-50 sm:text-6xl">
          Find out why customers&nbsp;
          <span className="text-brand-400">really</span> cancel
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted leading-relaxed">
          ChurnLens sends an exit survey the moment a Stripe subscription
          cancels, then uses AI to surface patterns in plain English — weekly,
          straight to your inbox.
        </p>

        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <Link
            href="/onboarding"
            className="rounded-xl bg-brand-500 px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 transition-all"
          >
            Connect Stripe — it&apos;s free
          </Link>
          <a
            href="#pricing"
            className="rounded-xl border border-surface-600 px-8 py-3.5 text-base font-medium text-zinc-300 hover:border-surface-500 hover:text-zinc-100 transition-all"
          >
            See pricing
          </a>
        </div>

        <p className="mt-4 text-sm text-muted">
          No credit card required. First survey fires on next cancellation.
        </p>
      </section>

      {/* Social proof strip */}
      <div className="border-y border-surface-700 bg-surface-800/50 py-5">
        <p className="text-center text-sm text-muted">
          Trusted by founders on{' '}
          <span className="text-zinc-300">Indie Hackers</span>,{' '}
          <span className="text-zinc-300">Product Hunt</span>, and{' '}
          <span className="text-zinc-300">Hacker News</span>
          {' '}— join them
        </p>
      </div>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="text-center text-3xl font-bold text-zinc-50">
          Everything you need. Nothing you don&apos;t.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted">
          Raaft costs $79/mo. Churnkey starts at $250. We cost $29 and do
          everything a solo founder actually needs.
        </p>

        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card group hover:border-brand-500/40 transition-colors">
              <div className="mb-4 text-3xl">{f.icon}</div>
              <h3 className="mb-2 text-lg font-semibold text-zinc-100">{f.title}</h3>
              <p className="text-sm text-muted leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>

        {/* How it works */}
        <div className="mt-20">
          <h2 className="text-center text-3xl font-bold text-zinc-50">
            How it works
          </h2>
          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Connect Stripe',
                body: 'Paste your API key or use OAuth. Takes 60 seconds. ChurnLens registers a webhook and is live immediately.',
              },
              {
                step: '02',
                title: 'Customer cancels',
                body: 'We intercept the webhook, send a respectful 3-question survey email to the churned customer within 5 minutes.',
              },
              {
                step: '03',
                title: 'You get clarity',
                body: 'Every Monday morning: top themes, representative quotes, MRR impact — one clean email. No dashboard required.',
              },
            ].map((item) => (
              <div key={item.step} className="flex gap-4">
                <span className="font-mono text-3xl font-bold text-brand-400/40 leading-none">
                  {item.step}
                </span>
                <div>
                  <h3 className="mb-1 font-semibold text-zinc-100">{item.title}</h3>
                  <p className="text-sm text-muted leading-relaxed">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="bg-surface-800/30 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold text-zinc-50">
            Indie-founder pricing
          </h2>
          <p className="mx-auto mt-3 max-w-md text-center text-muted">
            No per-seat fees. No enterprise add-ons. Cancel anytime.
          </p>

          {/* Lifetime deal banner */}
          <div className="mx-auto mt-8 max-w-xl rounded-xl border border-brand-500/40 bg-brand-500/10 p-4 text-center text-sm text-brand-200">
            <strong>Launch offer:</strong> $299 lifetime deal (Starter tier) —
            available during Product Hunt launch window.
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`card flex flex-col ${
                  plan.highlight
                    ? 'border-brand-500/60 ring-1 ring-brand-500/30'
                    : ''
                }`}
              >
                {plan.highlight && (
                  <div className="mb-4 inline-block rounded-full bg-brand-500/20 px-3 py-0.5 text-xs font-medium text-brand-300">
                    Most popular
                  </div>
                )}
                <div className="mb-1 text-lg font-semibold text-zinc-100">
                  {plan.name}
                </div>
                <div className="mb-1 flex items-end gap-1">
                  <span className="text-4xl font-bold text-zinc-50">{plan.price}</span>
                  <span className="text-muted mb-1">{plan.period}</span>
                </div>
                <p className="mb-4 text-sm text-muted">{plan.description}</p>
                <p className="mb-4 text-xs font-medium text-brand-400">{plan.limit}</p>
                <ul className="mb-6 flex-1 space-y-2">
                  {plan.features.map((feat) => (
                    <li key={feat} className="flex items-start gap-2 text-sm text-zinc-300">
                      <span className="mt-0.5 text-brand-400">✓</span>
                      {feat}
                    </li>
                  ))}
                </ul>
                <Link
                  href={plan.href}
                  className={`mt-auto rounded-lg px-4 py-2.5 text-sm font-medium text-center transition-colors ${
                    plan.highlight
                      ? 'bg-brand-500 text-white hover:bg-brand-600'
                      : 'border border-surface-600 text-zinc-300 hover:border-surface-500 hover:text-zinc-100'
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
      <section className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h2 className="text-3xl font-bold text-zinc-50">
          Stop guessing. Start listening.
        </h2>
        <p className="mt-3 text-muted">
          Your next cancellation will tell you something. ChurnLens makes sure
          you actually hear it.
        </p>
        <Link
          href="/onboarding"
          className="mt-8 inline-block rounded-xl bg-brand-500 px-10 py-4 text-base font-semibold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 transition-all"
        >
          Connect Stripe for free
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-surface-700 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm text-muted sm:flex-row">
          <span>
            Churn<span className="text-brand-400">Lens</span> — built by a
            founder, for founders.
          </span>
          <div className="flex gap-6">
            <a href="#" className="hover:text-zinc-100 transition-colors">Privacy</a>
            <a href="#" className="hover:text-zinc-100 transition-colors">Terms</a>
            <a href="mailto:hello@churnlens.com" className="hover:text-zinc-100 transition-colors">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
