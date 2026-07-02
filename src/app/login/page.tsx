'use client';

import Link from 'next/link';
import { useState, useEffect, FormEvent } from 'react';

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
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <Link href="/" className="mb-10 text-xl font-semibold tracking-tight">
        Churn<span className="text-brand-400">Lens</span>
      </Link>

      <div className="w-full max-w-md card">
        {sent ? (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-500/10">
              <svg className="h-6 w-6 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-zinc-50">Check your email</h1>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              If an account exists for that address, a login link is on its way. It&apos;s valid for
              15 minutes.
            </p>
          </div>
        ) : (
          <>
            <h1 className="mb-1 text-xl font-bold text-zinc-50">Log in to ChurnLens</h1>
            <p className="mb-6 text-sm text-muted leading-relaxed">
              Enter your email and we&apos;ll send you a one-time login link — no password needed.
            </p>

            {expired && (
              <p className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
                That link is invalid or has expired. Request a fresh one below.
              </p>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-zinc-300">
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
                  className="w-full rounded-lg border border-surface-600 bg-surface-700 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>

              {error && (
                <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-400">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="w-full rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Sending…' : 'Send login link'}
              </button>
            </form>

            <p className="mt-6 border-t border-surface-700 pt-6 text-xs text-muted">
              New to ChurnLens?{' '}
              <Link href="/onboarding" className="text-brand-400 hover:underline">
                Connect Stripe to get started
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
