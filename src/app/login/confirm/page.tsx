import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import SiteHeader from '@/components/SiteHeader';
import { findUsableLoginToken } from '@/lib/login-token';
import { reportError } from '@/lib/report-error';
import ConfirmSignInForm from './ConfirmSignInForm';

export const metadata: Metadata = {
  title: 'Confirm sign-in',
  // The token is in this page's URL until it is used. strict-origin sends at
  // most the bare origin as Referer — never the path or query — to anyone,
  // this app included, whatever the header grows to link to.
  //
  // NOT no-referrer: under that policy browsers send `Origin: null` on a
  // POST, so the confirm form's own same-origin submission would be refused
  // by assertSameOrigin in /api/auth/verify and nobody could sign in.
  referrer: 'strict-origin',
  robots: { index: false, follow: false },
};

/**
 * Where the emailed magic link lands (GET /api/auth/verify forwards here):
 * "Sign in to ChurnLens as <email>?" and one button.
 *
 * Opening a link must not sign anyone in — that was the login-CSRF hole (see
 * src/app/api/auth/verify/route.ts). This page only looks the token up; the
 * button's same-origin POST is what spends it. Showing the address is the
 * point: someone walked here with an attacker's link sees an address that is
 * not theirs, and nothing has happened yet.
 *
 * An unknown, used or expired token goes to the same /login error the old
 * one-step link used, and the address is shown only for a usable token — the
 * page tells the link holder nothing the email it came in did not.
 */
export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: { token?: string | string[] };
}) {
  // A repeated ?token= parses as string[]; the redirect from verify only ever
  // writes one, so anything else is hand-made and gets the first value.
  const token = Array.isArray(searchParams.token) ? searchParams.token[0] : searchParams.token;
  let pending: { email: string } | null = null;
  if (token) {
    try {
      pending = await findUsableLoginToken(token);
    } catch (err) {
      // Reported, then rethrown so Next still renders its error page: Next 14
      // logs a throw from a server component but tells nobody, and a confirm
      // page that cannot read the database signs nobody in. No token in the
      // meta: it signs someone in until it is used.
      reportError('auth.confirm', err, { step: 'token_lookup' });
      throw err;
    }
  }
  // Outside the try: redirect() works by throwing.
  if (!token || !pending) redirect('/login?error=expired');

  return (
    <div className="flex flex-col min-h-full">
      <SiteHeader active="login" />

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-md bg-white dark:bg-[#121214] rounded-[2.5rem] shadow-2xl shadow-zinc-200/50 dark:shadow-black/50 border border-zinc-100 dark:border-zinc-800 p-10 transition-colors duration-500">
          <h1 className="mb-6 text-2xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
            Sign in to ChurnLens as <span className="break-all text-teal-700 dark:text-teal-300">{pending.email}</span>?
          </h1>

          <ConfirmSignInForm token={token} />

          <p className="mt-6 text-xs font-medium text-muted leading-relaxed">
            Not your address, or you didn&apos;t ask to sign in? Close this page — nothing has
            happened. To use your own account,{' '}
            <Link href="/login" className="font-bold underline underline-offset-2 hover:no-underline">
              request a new link
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
