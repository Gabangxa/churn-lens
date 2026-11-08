'use client';

import { useState } from 'react';

/**
 * The "Sign in" button: a native form POST to /api/auth/verify, the only
 * request that spends the link and mints a session. A plain form so it works
 * without JavaScript and so the browser sends the Origin header that route
 * checks.
 *
 * Client-side only to stop a double-click. The link is single use, so a
 * second submission racing the first would land on "this link has expired"
 * even though the first one signed the founder in. Disabling the button from
 * onSubmit does not cancel the submission already under way — it only makes
 * the second click a no-op.
 */
export default function ConfirmSignInForm({ token }: { token: string }) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <form method="POST" action="/api/auth/verify" onSubmit={() => setSubmitting(true)}>
      <input type="hidden" name="token" value={token} />
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-full bg-teal-400 px-6 py-3.5 text-sm font-extrabold uppercase tracking-widest text-white dark:text-zinc-950 shadow-[4px_4px_0px_0px_rgba(15,118,110,1)] dark:shadow-[4px_4px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-teal-500 dark:hover:bg-teal-400/80 transition-all disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:translate-x-0 disabled:translate-y-0"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
