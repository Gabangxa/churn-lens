'use client';

import Link from 'next/link';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Wordmark from '@/components/Wordmark';

export default function OnboardingPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/onboarding/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, apiKey }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong.');
        return;
      }

      router.push('/dashboard');
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

      {/* Step indicator */}
      <div className="mb-8 flex items-center gap-2 text-sm font-medium text-muted">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-pink-500 text-xs font-extrabold text-white">
          1
        </span>
        <span className="font-bold text-zinc-900 dark:text-zinc-100">Connect Stripe</span>
        <span className="mx-2 text-zinc-300 dark:text-zinc-700">———</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-zinc-200 dark:border-zinc-700 text-xs font-bold text-muted">
          2
        </span>
        <span>Done</span>
      </div>

      <div className="w-full max-w-md bg-white dark:bg-[#121214] rounded-[2.5rem] shadow-2xl shadow-zinc-200/50 dark:shadow-black/50 border border-zinc-100 dark:border-zinc-800 p-10 transition-colors duration-500">
        <h1 className="mb-2 text-2xl font-bold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Connect your Stripe account
        </h1>
        <p className="mb-8 text-sm font-medium text-muted leading-relaxed">
          ChurnLens registers a webhook for{' '}
          <code className="rounded bg-[#f8f9fa] dark:bg-[#18181b] border border-zinc-100 dark:border-zinc-800 px-1.5 py-0.5 font-mono text-xs text-pink-600 dark:text-pink-400">
            customer.subscription.deleted
          </code>
          . We listen — you get clarity. Read-only access only.
        </p>

        <button
          type="button"
          className="mb-3 flex w-full items-center justify-center gap-3 rounded-full bg-[#635BFF] px-6 py-3.5 text-sm font-extrabold uppercase tracking-widest text-white shadow-[4px_4px_0px_0px_#3f38c9] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-[#5147e6] transition-all"
        >
          <svg width="18" height="18" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M15.448 14.27c-2.488-.624-3.288-1.044-3.288-2.004 0-.888.78-1.404 2.076-1.404 1.548 0 3.132.588 4.476 1.584l1.884-3.564C18.924 7.698 17.04 7 14.448 7c-4.032 0-6.804 2.064-6.804 5.34 0 3.54 2.64 4.584 5.58 5.316 2.496.624 3.18 1.128 3.18 2.1 0 1.02-.888 1.584-2.364 1.584-1.884 0-3.66-.732-5.136-1.98L7 22.836C8.652 24.312 11.028 25 13.944 25c4.224 0 6.96-1.98 6.96-5.484 0-3.348-2.34-4.608-5.456-5.246z" fill="white"/>
          </svg>
          Continue with Stripe
        </button>

        <div className="relative my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
          <span className="text-xs font-bold uppercase tracking-wider text-muted">or</span>
          <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
        </div>

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
            <p className="mt-2 text-xs font-medium text-muted">Used to send you the weekly ChurnLens digest.</p>
          </div>

          <div>
            <label htmlFor="stripe-key" className="mb-2 block text-sm font-bold text-zinc-900 dark:text-zinc-100">
              Stripe Restricted API Key
            </label>
            <input
              id="stripe-key"
              type="password"
              placeholder="rk_live_..."
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full rounded-full border-2 border-zinc-200 dark:border-zinc-800 bg-[#f8f9fa] dark:bg-[#18181b] px-5 py-3 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 transition-all focus:border-blue-500 focus:bg-white dark:focus:bg-[#121214] focus:outline-none"
            />
            <p className="mt-2 text-xs font-medium text-muted">
              Needs: <code className="font-mono text-pink-600 dark:text-pink-400">customers:read</code>,{' '}
              <code className="font-mono text-pink-600 dark:text-pink-400">subscriptions:read</code>,{' '}
              <code className="font-mono text-pink-600 dark:text-pink-400">webhooks:write</code>
            </p>
          </div>

          {error && (
            <p className="rounded-2xl border-2 border-pink-500/40 bg-pink-500/10 px-4 py-2.5 text-sm font-bold text-pink-600 dark:text-pink-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !email.trim() || !apiKey.trim()}
            className="w-full rounded-full bg-teal-400 px-6 py-3.5 text-sm font-extrabold uppercase tracking-widest text-white dark:text-zinc-950 shadow-[4px_4px_0px_0px_rgba(15,118,110,1)] dark:shadow-[4px_4px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-teal-500 dark:hover:bg-teal-400/80 transition-all disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:translate-x-0 disabled:translate-y-0"
          >
            {loading ? 'Saving…' : 'Save and activate'}
          </button>
        </form>

        <div className="mt-8 space-y-2 border-t border-zinc-100 dark:border-zinc-800 pt-6">
          {[
            'We never charge your customers — we only read cancellation events.',
            'API key is encrypted at rest with AES-256.',
            'Disconnect in one click from settings.',
          ].map((note) => (
            <p key={note} className="flex items-start gap-2 text-xs font-medium text-muted">
              <span className="mt-0.5 font-bold text-teal-500 dark:text-teal-300">✓</span>
              {note}
            </p>
          ))}
        </div>
      </div>

      <p className="mt-6 text-sm font-medium text-muted">
        Already connected?{' '}
        <Link href="/login" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
          Log in
        </Link>
      </p>

      <p className="mt-3 text-xs font-medium text-muted">
        Questions?{' '}
        <a href="mailto:hello@churnlens.com" className="font-bold text-pink-500 dark:text-pink-400 hover:underline">
          hello@churnlens.com
        </a>
      </p>
    </div>
  );
}
