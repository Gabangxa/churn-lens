/**
 * Survey page — the page a churned customer lands on.
 *
 * [token] is an HMAC-signed payload encoding:
 *   { orgId, customerId, subscriptionId, exp }
 * Config (display name / logo / extra reasons) is never encoded in the
 * token — it's loaded from the DB by payload.orgId at render time (CL-1).
 *
 * WCAG AA minimum: labels explicitly associated with inputs,
 * sufficient color contrast, focus indicators, no color-only cues.
 */

import { verifySurveyToken } from '@/lib/crypto';
import { BUILTIN_CANCELLATION_REASONS, loadSurveyConfig } from '@/lib/survey-config';

export default async function SurveyPage({ params }: { params: { token: string } }) {
  const payload = verifySurveyToken(params.token);
  const expired = !payload || Date.now() > payload.exp;
  const isPreview = payload?.kind === 'preview';

  if (expired || !payload) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="w-full max-w-sm">
          <span className="text-sm font-medium text-muted">
            Powered by <span className="font-extrabold font-display text-zinc-900 dark:text-zinc-100">ChurnLens</span>
          </span>
          <h1 className="mt-8 text-3xl font-bold font-display tracking-tight text-zinc-900 dark:text-zinc-100">
            This link has expired
          </h1>
          <p className="mt-3 text-sm font-medium text-muted leading-relaxed">
            Survey links are valid for 7 days. This one is no longer active.
          </p>
        </div>
      </div>
    );
  }

  const config = await loadSurveyConfig(payload.orgId);
  const builtinReasons = BUILTIN_CANCELLATION_REASONS.filter((reason) => reason !== 'Other');
  // Built-ins → custom reasons → 'Other' last (Resolved decisions #2). Zero-config
  // orgs have no custom reasons, so this is byte-identical to the original 8.
  const reasons = [...builtinReasons, ...config.customReasons, 'Other'];
  const founderCopy = config.displayName ? `the ${config.displayName} team` : 'the founder';

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 md:px-6 py-12">
      <div className="w-full max-w-2xl">
        {isPreview && (
          <div className="mb-6 rounded-3xl border-2 border-yellow-300 bg-yellow-300/20 dark:bg-yellow-300/10 px-5 py-3 text-center text-sm font-bold text-yellow-800 dark:text-yellow-300">
            Preview mode — this is what churned customers see. Submissions are not saved.
          </div>
        )}

        {/* Brand mark — subtle */}
        <div className="mb-8 text-center">
          <span className="text-sm font-medium text-muted">
            Powered by <span className="font-extrabold font-display text-zinc-900 dark:text-zinc-100">ChurnLens</span>
          </span>
        </div>

        <div className="bg-white dark:bg-[#121214] rounded-[2.5rem] shadow-2xl shadow-zinc-200/50 dark:shadow-black/50 border border-zinc-100 dark:border-zinc-800 p-8 md:p-14 transition-colors duration-500">
          {/* Header */}
          <div className="mb-10 text-center">
            {config.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- external, org-supplied URL; no server-side fetch/reachability check (see spec edge cases).
              <img
                src={config.logoUrl}
                alt={config.displayName ? `${config.displayName} logo` : 'Company logo'}
                className="mx-auto mb-6 h-12 w-auto max-w-[200px] object-contain"
              />
            )}
            <div className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-full bg-pink-500 dark:bg-pink-500/20 text-white dark:text-pink-400 shadow-lg shadow-pink-500/30 dark:shadow-none transform -rotate-12 transition-colors duration-500">
              <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path strokeLinecap="round" d="M16 16s-1.5-2-4-2-4 2-4 2" />
                <line x1="9" y1="9" x2="9.01" y2="9" strokeLinecap="round" strokeWidth={3} />
                <line x1="15" y1="9" x2="15.01" y2="9" strokeLinecap="round" strokeWidth={3} />
              </svg>
            </div>
            <h1 className="text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
              Sorry to see you go
            </h1>
            <p className="mx-auto mt-4 max-w-lg text-base md:text-lg font-medium text-muted leading-relaxed">
              Two minutes, three questions. Your answer goes straight to {founderCopy} — not a support queue. It helps them build a better product.
            </p>
          </div>

          <form action="/api/survey" method="POST" className="space-y-10">
            <input type="hidden" name="token" value={params.token} />

            {/* Q1 — Reason */}
            <fieldset>
              <legend className="mb-4 block text-base font-bold font-display text-zinc-900 dark:text-zinc-100">
                1. What was the main reason you cancelled?{' '}
                <span className="text-pink-500 dark:text-pink-400">*</span>
              </legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {reasons.map((reason) => (
                  <label
                    key={reason}
                    className="flex cursor-pointer items-center gap-3 rounded-full border-2 border-zinc-200 dark:border-zinc-700 px-5 py-3.5 text-sm font-bold tracking-wide text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:border-zinc-300 dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-500 has-[:checked]:text-white has-[:checked]:shadow-[4px_4px_0px_0px_rgba(29,78,216,1)] has-[:checked]:translate-x-[-2px] has-[:checked]:translate-y-[-2px]"
                  >
                    <input
                      type="radio"
                      name="reason"
                      value={reason}
                      required
                      className="h-4 w-4 shrink-0 accent-white"
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
                className="mb-3 block text-base font-bold font-display text-zinc-900 dark:text-zinc-100"
              >
                2. Can you tell us a bit more?
              </label>
              <textarea
                id="open-text"
                name="open_text"
                rows={4}
                placeholder="Anything helps — even a sentence."
                className="w-full rounded-3xl border-2 border-zinc-200 dark:border-zinc-800 bg-[#f8f9fa] dark:bg-[#18181b] p-5 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 shadow-inner transition-all focus:border-blue-500 focus:bg-white dark:focus:bg-[#121214] focus:outline-none resize-none"
              />
            </div>

            {/* Q3 — Comeback */}
            <div>
              <label
                htmlFor="comeback"
                className="mb-3 block text-base font-bold font-display text-zinc-900 dark:text-zinc-100"
              >
                3. What would bring you back?{' '}
                <span className="font-sans text-sm font-medium text-muted">(optional)</span>
              </label>
              <textarea
                id="comeback"
                name="comeback_text"
                rows={3}
                placeholder="A specific feature, a lower price, better onboarding…"
                className="w-full rounded-3xl border-2 border-zinc-200 dark:border-zinc-800 bg-[#f8f9fa] dark:bg-[#18181b] p-5 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 shadow-inner transition-all focus:border-blue-500 focus:bg-white dark:focus:bg-[#121214] focus:outline-none resize-none"
              />
            </div>

            {/* Submit */}
            <div className="flex justify-center">
              <button
                type="submit"
                className="px-10 py-4 rounded-full bg-teal-400 font-extrabold uppercase tracking-widest text-sm text-white dark:text-zinc-950 shadow-[6px_6px_0px_0px_rgba(15,118,110,1)] dark:shadow-[6px_6px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[6px] hover:translate-y-[6px] hover:bg-teal-500 dark:hover:bg-teal-400/80 transition-all"
              >
                Send feedback
              </button>
            </div>

            <p className="text-center text-xs font-medium text-muted">
              Your response is only shared with the product team. We
              won&apos;t contact you.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
