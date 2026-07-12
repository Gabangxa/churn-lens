import Link from 'next/link';
import Wordmark from '@/components/Wordmark';
import ThemeToggle from '@/components/ThemeToggle';

const FEATURES = [
  {
    icon: '⚡',
    accent: 'bg-yellow-300 dark:bg-yellow-300/20',
    title: 'Stripe-native',
    description:
      'Connect once. Every cancellation triggers an exit survey automatically — no code, no Zapier.',
  },
  {
    icon: '🧠',
    accent: 'bg-teal-400 dark:bg-teal-400/20',
    title: 'AI theme synthesis',
    description:
      'GPT-4o-mini clusters responses nightly. Stop reading raw text; start reading patterns.',
  },
  {
    icon: '📬',
    accent: 'bg-pink-500 dark:bg-pink-500/20',
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
    cta: 'Start 14-day trial',
    href: '/onboarding?plan=growth',
    highlight: false,
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col min-h-full">
      {/* Nav */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-[#09090b]/90 backdrop-blur transition-colors duration-500">
        <div className="flex items-center justify-between px-8 md:px-12 py-6">
          <Wordmark />
          <nav className="hidden md:flex items-center space-x-10">
            <a href="#features" className="font-bold text-sm tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 transition-colors">
              Features
            </a>
            <a href="#pricing" className="font-bold text-sm tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 transition-colors">
              Pricing
            </a>
            <Link href="/login" className="font-bold text-sm tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 transition-colors">
              Log in
            </Link>
          </nav>
          <div className="flex items-center space-x-4">
            <ThemeToggle />
            <Link
              href="/onboarding"
              className="px-6 py-2.5 rounded-full border-2 border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 text-xs font-bold uppercase tracking-widest shadow-[4px_4px_0px_0px_#18181b] dark:shadow-[4px_4px_0px_0px_#f4f4f5] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-zinc-900 hover:text-white dark:hover:bg-zinc-100 dark:hover:text-black transition-all active:scale-95"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="px-8 md:px-12 py-16 md:py-24">
        <div className="inline-flex items-center gap-2 rounded-full border-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#121214] px-5 py-2 text-sm font-bold text-zinc-600 dark:text-zinc-300 transition-colors duration-500">
          <span className="h-2 w-2 rounded-full bg-pink-500 animate-pulse" />
          Built for founders at $500–$10K MRR
        </div>

        <h1 className="mt-8 max-w-5xl text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-extrabold font-display leading-[1.02] tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Find out why customers{' '}
          <span className="text-pink-500 dark:text-pink-400">really</span> cancel
        </h1>

        <p className="mt-8 max-w-2xl text-lg md:text-xl text-zinc-500 dark:text-zinc-400 font-medium leading-relaxed transition-colors duration-500">
          ChurnLens sends an exit survey the moment a Stripe subscription
          cancels, then uses AI to surface patterns in plain English — weekly,
          straight to your inbox.
        </p>

        <div className="mt-12 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          <Link
            href="/onboarding"
            className="px-10 py-4 rounded-full bg-teal-400 text-white dark:text-zinc-950 font-extrabold uppercase tracking-widest text-sm shadow-[6px_6px_0px_0px_rgba(15,118,110,1)] dark:shadow-[6px_6px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[6px] hover:translate-y-[6px] hover:bg-teal-500 dark:hover:bg-teal-400/80 transition-all"
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
          No credit card required. First survey fires on next cancellation.
        </p>
      </section>

      {/* Social proof strip */}
      <div className="border-y border-zinc-100 dark:border-zinc-800 bg-[#f8f9fa] dark:bg-[#121214] py-5 transition-colors duration-500">
        <p className="text-center text-sm font-medium text-muted">
          Trusted by founders on{' '}
          <span className="font-bold text-zinc-900 dark:text-zinc-200">Indie Hackers</span>,{' '}
          <span className="font-bold text-zinc-900 dark:text-zinc-200">Product Hunt</span>, and{' '}
          <span className="font-bold text-zinc-900 dark:text-zinc-200">Hacker News</span>
          {' '}— join them
        </p>
      </div>

      {/* Features */}
      <section id="features" className="w-full px-8 md:px-12 py-24">
        <h2 className="text-4xl md:text-5xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Everything you need. Nothing you don&apos;t.
        </h2>
        <p className="mt-4 max-w-xl font-medium text-muted">
          Raaft costs $79/mo. Churnkey starts at $250. We cost $29 and do
          everything a solo founder actually needs.
        </p>

        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              className="card group relative overflow-hidden hover:-translate-y-1 transition-all duration-300"
            >
              <div
                className={`absolute -right-6 -top-6 w-24 h-24 rounded-full opacity-20 dark:opacity-10 group-hover:scale-150 transition-transform duration-500 ${['bg-yellow-300', 'bg-teal-400', 'bg-pink-500'][i % 3]}`}
              />
              <div
                className={`relative z-10 mb-5 flex h-14 w-14 items-center justify-center rounded-full text-2xl shadow-lg dark:shadow-none transform -rotate-6 transition-colors duration-500 ${f.accent}`}
              >
                {f.icon}
              </div>
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
                color: 'text-pink-500 dark:text-pink-400',
                title: 'Connect Stripe',
                body: 'Paste your API key or use OAuth. Takes 60 seconds. ChurnLens registers a webhook and is live immediately.',
              },
              {
                step: '02',
                color: 'text-teal-500 dark:text-teal-300',
                title: 'Customer cancels',
                body: 'We intercept the webhook, send a respectful 3-question survey email to the churned customer within 5 minutes.',
              },
              {
                step: '03',
                color: 'text-blue-500 dark:text-blue-400',
                title: 'You get clarity',
                body: 'Every Monday morning: top themes, representative quotes, MRR impact — one clean email. No dashboard required.',
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
            No per-seat fees. No enterprise add-ons. Cancel anytime.
          </p>

          {/* Lifetime deal banner */}
          <div className="mt-10 rounded-3xl border-2 border-yellow-300 bg-yellow-300/20 dark:bg-yellow-300/10 p-5 text-sm font-bold text-yellow-800 dark:text-yellow-300 transition-colors duration-500">
            Launch offer: $299 lifetime deal (Starter tier) — available during
            Product Hunt launch window.
          </div>

          <div className="mt-14 grid gap-6 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`flex flex-col rounded-3xl p-8 bg-white dark:bg-[#09090b] transition-all duration-300 ${
                  plan.highlight
                    ? 'border-2 border-zinc-900 dark:border-zinc-100 shadow-[8px_8px_0px_0px_#ec4899]'
                    : 'border border-zinc-100 dark:border-zinc-800 hover:-translate-y-1'
                }`}
              >
                {plan.highlight && (
                  <div className="mb-4 self-start rounded-full bg-pink-500 px-4 py-1 text-xs font-bold uppercase tracking-widest text-white">
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
                <p className="mb-5 text-xs font-bold uppercase tracking-wider text-pink-500 dark:text-pink-400">
                  {plan.limit}
                </p>
                <ul className="mb-8 flex-1 space-y-2.5">
                  {plan.features.map((feat) => (
                    <li key={feat} className="flex items-start gap-2 text-sm font-medium text-zinc-600 dark:text-zinc-300">
                      <span className="mt-0.5 font-bold text-teal-500 dark:text-teal-300">✓</span>
                      {feat}
                    </li>
                  ))}
                </ul>
                <Link
                  href={plan.href}
                  className={`mt-auto rounded-full px-6 py-3 text-center text-xs font-bold uppercase tracking-widest transition-all ${
                    plan.highlight
                      ? 'bg-pink-500 text-white shadow-[4px_4px_0px_0px_rgba(159,18,57,1)] dark:shadow-[4px_4px_0px_0px_#f472b6] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px]'
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
          href="/onboarding"
          className="mt-10 inline-block px-10 py-4 rounded-full bg-pink-500 text-white font-extrabold uppercase tracking-widest text-sm shadow-[6px_6px_0px_0px_rgba(159,18,57,1)] dark:shadow-[6px_6px_0px_0px_#f472b6] hover:shadow-none hover:translate-x-[6px] hover:translate-y-[6px] hover:bg-pink-600 dark:hover:bg-pink-500/80 transition-all"
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
            <a href="#" className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">Privacy</a>
            <a href="#" className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">Terms</a>
            <a href="mailto:hello@churnlens.com" className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
