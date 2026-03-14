import Link from 'next/link';

/**
 * Onboarding flow — single step: connect Stripe.
 * In production this would use Stripe OAuth (Connect) or a manual API key form.
 * The UX goal: no friction, done in 60 seconds.
 */
export default function OnboardingPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      {/* Logo */}
      <Link href="/" className="mb-10 text-xl font-semibold tracking-tight">
        Churn<span className="text-brand-400">Lens</span>
      </Link>

      {/* Progress indicator */}
      <div className="mb-8 flex items-center gap-2 text-sm text-muted">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
          1
        </span>
        <span className="text-zinc-100">Connect Stripe</span>
        <span className="mx-2 text-surface-600">———</span>
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-surface-600 text-xs text-muted">
          2
        </span>
        <span>Done</span>
      </div>

      {/* Card */}
      <div className="w-full max-w-md card">
        <h1 className="mb-1 text-xl font-bold text-zinc-50">
          Connect your Stripe account
        </h1>
        <p className="mb-8 text-sm text-muted leading-relaxed">
          ChurnLens registers a webhook for{' '}
          <code className="rounded bg-surface-700 px-1 py-0.5 text-xs text-brand-300">
            customer.subscription.deleted
          </code>
          . We listen — you get clarity. Read-only access only.
        </p>

        {/* Option A: OAuth (preferred) */}
        <button
          type="button"
          className="mb-3 flex w-full items-center justify-center gap-3 rounded-lg bg-[#635BFF] px-5 py-3 text-sm font-semibold text-white hover:bg-[#5147e6] transition-colors"
        >
          {/* Stripe S-mark SVG */}
          <svg width="18" height="18" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M15.448 14.27c-2.488-.624-3.288-1.044-3.288-2.004 0-.888.78-1.404 2.076-1.404 1.548 0 3.132.588 4.476 1.584l1.884-3.564C18.924 7.698 17.04 7 14.448 7c-4.032 0-6.804 2.064-6.804 5.34 0 3.54 2.64 4.584 5.58 5.316 2.496.624 3.18 1.128 3.18 2.1 0 1.02-.888 1.584-2.364 1.584-1.884 0-3.66-.732-5.136-1.98L7 22.836C8.652 24.312 11.028 25 13.944 25c4.224 0 6.96-1.98 6.96-5.484 0-3.348-2.34-4.608-5.456-5.246z" fill="white"/>
          </svg>
          Continue with Stripe
        </button>

        <div className="relative my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-surface-700" />
          <span className="text-xs text-muted">or</span>
          <div className="h-px flex-1 bg-surface-700" />
        </div>

        {/* Option B: API key */}
        <div className="space-y-4">
          <div>
            <label htmlFor="stripe-key" className="mb-1.5 block text-sm font-medium text-zinc-300">
              Stripe Restricted API Key
            </label>
            <input
              id="stripe-key"
              type="password"
              placeholder="rk_live_..."
              autoComplete="off"
              className="w-full rounded-lg border border-surface-600 bg-surface-700 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <p className="mt-1.5 text-xs text-muted">
              Needs: <code className="text-brand-400">customers:read</code>,{' '}
              <code className="text-brand-400">subscriptions:read</code>,{' '}
              <code className="text-brand-400">webhooks:write</code>
            </p>
          </div>

          <button
            type="button"
            className="w-full rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition-colors"
          >
            Save and activate
          </button>
        </div>

        {/* Trust signals */}
        <div className="mt-8 space-y-2 border-t border-surface-700 pt-6">
          {[
            'We never charge your customers — we only read cancellation events.',
            'API key is encrypted at rest with AES-256.',
            'Disconnect in one click from settings.',
          ].map((note) => (
            <p key={note} className="flex items-start gap-2 text-xs text-muted">
              <span className="mt-0.5 text-brand-400">✓</span>
              {note}
            </p>
          ))}
        </div>
      </div>

      <p className="mt-6 text-xs text-muted">
        Questions?{' '}
        <a href="mailto:hello@churnlens.com" className="text-brand-400 hover:underline">
          hello@churnlens.com
        </a>
      </p>
    </div>
  );
}
