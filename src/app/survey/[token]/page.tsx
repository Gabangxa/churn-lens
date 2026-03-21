/**
 * Survey page — the page a churned customer lands on.
 *
 * The [token] is an HMAC-signed payload encoding:
 *   { orgId, customerId, subscriptionId, exp }
 *
 * WCAG AA minimum: labels explicitly associated with inputs,
 * sufficient color contrast, focus indicators, no color-only cues.
 */

import { verifySurveyToken } from '@/lib/crypto';

const CANCELLATION_REASONS = [
  'Too expensive for my budget',
  'Missing a feature I need',
  'Switched to a competitor',
  'Stopped needing this type of tool',
  'Product was too difficult to use',
  'Had a bad support experience',
  'Just trying things out — not ready to commit',
  'Other',
];

export default async function SurveyPage({ params }: { params: { token: string } }) {
  const payload = verifySurveyToken(params.token);
  const expired = !payload || Date.now() > payload.exp;

  if (expired) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 py-16 text-center">
        <div className="w-full max-w-sm">
          <span className="text-sm text-zinc-500">
            Powered by Churn<span className="text-brand-400">Lens</span>
          </span>
          <h1 className="mt-8 text-xl font-bold text-zinc-100">This link has expired</h1>
          <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
            Survey links are valid for 7 days. This one is no longer active.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 py-16">
      <div className="w-full max-w-lg">
        {/* Brand mark — subtle */}
        <div className="mb-8 text-center">
          <span className="text-sm text-zinc-500">
            Powered by Churn<span className="text-brand-400">Lens</span>
          </span>
        </div>

        {/* Header */}
        <div className="mb-10 text-center">
          <h1 className="text-2xl font-bold text-zinc-50">
            Sorry to see you go.
          </h1>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            It takes two minutes. Your answer goes directly to the founder — not
            a support queue. It helps them build a better product.
          </p>
        </div>

        <form
          action="/api/survey"
          method="POST"
          className="space-y-8"
        >
          <input type="hidden" name="token" value={params.token} />

          {/* Q1 — Reason dropdown */}
          <fieldset>
            <legend className="mb-2 block text-sm font-semibold text-zinc-200">
              1. What was the main reason you cancelled?{' '}
              <span className="text-brand-400">*</span>
            </legend>
            <div className="space-y-2">
              {CANCELLATION_REASONS.map((reason) => (
                <label
                  key={reason}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-300 transition-colors hover:border-brand-500/50 hover:text-zinc-100 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-500/10 has-[:checked]:text-zinc-50"
                >
                  <input
                    type="radio"
                    name="reason"
                    value={reason}
                    required
                    className="h-4 w-4 accent-amber-400"
                  />
                  {reason}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Q2 — Open text */}
          <div>
            <label
              htmlFor="open-text"
              className="mb-2 block text-sm font-semibold text-zinc-200"
            >
              2. Can you tell us a bit more?
            </label>
            <textarea
              id="open-text"
              name="open_text"
              rows={4}
              placeholder="Anything helps — even a sentence."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {/* Q3 — Comeback */}
          <div>
            <label
              htmlFor="comeback"
              className="mb-2 block text-sm font-semibold text-zinc-200"
            >
              3. What would bring you back? <span className="font-normal text-zinc-500">(optional)</span>
            </label>
            <textarea
              id="comeback"
              name="comeback_text"
              rows={3}
              placeholder="A specific feature, a lower price, better onboarding…"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            className="w-full rounded-xl bg-brand-500 py-3.5 text-base font-semibold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 transition-colors"
          >
            Send feedback
          </button>

          <p className="text-center text-xs text-zinc-500">
            Your response is only shared with the product team. We
            won&apos;t contact you.
          </p>
        </form>
      </div>
    </div>
  );
}
