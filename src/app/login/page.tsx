'use client';

import Link from 'next/link';
import { useState, useEffect, FormEvent } from 'react';
import Wordmark from '@/components/Wordmark';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // Surfaced when /api/auth/verify bounces an invalid/expired/used link back here.
  // Read from the URL client-side to avoid a useSearchParams Suspense boundary.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('error') === 'expired') {
      setExpired(true);
    }
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setExpired(false);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Something went wrong. Please try again.');
        return;
      }

      setSent(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <Link href="/" className="mb-10">
        <Wordmark />
      </Link>

      <div className="w-full max-w-md bg-white dark:bg-[#121214] rounded-[2.5rem] shadow-2xl shadow-zinc-200/50 dark:shadow-black/50 border border-zinc-100 dark:border-zinc-800 p-10 transition-colors duration-500">
        {sent ? (
          <div className="text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-teal-400 dark:bg-teal-400/20 text-white dark:text-teal-300 shadow-lg shadow-teal-400/30 dark:shadow-none transform -rotate-6 transition-colors duration-500">
              <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
              Check your email
            </h1>
            <p className="mt-3 text-sm font-medium text-muted leading-relaxed">
              If an account exists for that address, a login link is on its way. It&apos;s valid for
              15 minutes.
            </p>
          </div>
        ) : (
          <>
            <h1 className="mb-2 text-2xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
              Log in to ChurnLens
            </h1>
            <p className="mb-8 text-sm font-medium text-muted leading-relaxed">
              Enter your email and we&apos;ll send you a one-time login link — no password needed.
            </p>

            {expired && (
              <p className="mb-4 rounded-2xl border-2 border-yellow-300 bg-yellow-300/20 dark:bg-yellow-300/10 px-4 py-2.5 text-sm font-bold text-yellow-800 dark:text-yellow-300">
                That link is invalid or has expired. Request a fresh one below.
              </p>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="mb-2 block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  Your email address
                </label>
                <input
                  id="email"
                  type="email"
                  placeholder="you@yourcompany.com"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-full border-2 border-zinc-200 dark:border-zinc-800 bg-[#f8f9fa] dark:bg-[#18181b] px-5 py-3 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 transition-all focus:border-blue-500 focus:bg-white dark:focus:bg-[#121214] focus:outline-none"
                />
              </div>

              {error && (
                <p className="rounded-2xl border-2 border-pink-500/40 bg-pink-500/10 px-4 py-2.5 text-sm font-bold text-pink-600 dark:text-pink-400">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="w-full rounded-full bg-teal-400 px-6 py-3.5 text-sm font-extrabold uppercase tracking-widest text-white dark:text-zinc-950 shadow-[4px_4px_0px_0px_rgba(15,118,110,1)] dark:shadow-[4px_4px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-teal-500 dark:hover:bg-teal-400/80 transition-all disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:translate-x-0 disabled:translate-y-0"
              >
                {loading ? 'Sending…' : 'Send login link'}
              </button>
            </form>

            <p className="mt-8 border-t border-zinc-100 dark:border-zinc-800 pt-6 text-xs font-medium text-muted">
              New to ChurnLens?{' '}
              <Link href="/onboarding" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
                Connect Stripe to get started
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
