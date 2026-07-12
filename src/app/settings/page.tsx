'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Wordmark from '@/components/Wordmark';
import ThemeToggle from '@/components/ThemeToggle';

export default function SettingsPage() {
  const router = useRouter();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch('/api/settings/status');
        if (res.status === 401) {
          router.push('/onboarding');
          return;
        }
        const data = await res.json();
        setConnected(data.connected ?? false);
      } catch {
        setConnected(false);
      }
    }
    fetchStatus();
  }, [router]);

  async function handleDisconnect() {
    if (!confirm('Are you sure you want to disconnect Stripe? This will remove your API key and delete any registered webhooks.')) {
      return;
    }

    setError(null);
    setDisconnecting(true);

    try {
      const res = await fetch('/api/settings/disconnect', {
        method: 'DELETE',
        redirect: 'follow',
      });

      if (res.redirected) {
        window.location.href = res.url;
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to disconnect.');
        return;
      }

      router.push('/onboarding');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleSendTest() {
    setTestResult(null);
    setSendingTest(true);
    try {
      const res = await fetch('/api/survey/test', { method: 'POST' });
      if (res.status === 401) {
        router.push('/onboarding');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setTestResult({ ok: false, message: data.error || 'Failed to send test survey.' });
        return;
      }
      setTestResult({ ok: true, message: `Test survey sent to ${data.sentTo}. Check your inbox.` });
    } catch {
      setTestResult({ ok: false, message: 'Network error. Please try again.' });
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <div className="flex flex-col min-h-full">
      {/* Nav */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-[#09090b]/90 backdrop-blur transition-colors duration-500">
        <div className="flex items-center justify-between px-8 md:px-12 py-6">
          <Link href="/dashboard">
            <Wordmark />
          </Link>
          <nav className="hidden md:flex items-center space-x-10">
            <Link
              href="/dashboard"
              className="font-bold text-sm tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 transition-colors"
            >
              Dashboard
            </Link>
            <span className="font-bold text-sm tracking-wide text-zinc-900 dark:text-white">Settings</span>
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-8 py-8 pb-16">
        <h1 className="mb-10 text-5xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Settings
        </h1>

        <div className="card">
          <h2 className="mb-1 text-2xl font-bold font-display text-zinc-900 dark:text-white transition-colors duration-500">
            Stripe Connection
          </h2>
          <p className="mb-6 text-sm font-medium text-muted">
            Manage your Stripe integration. ChurnLens uses your restricted API key to listen for cancellation events.
          </p>

          {connected === null ? (
            <div className="flex items-center gap-2 text-sm font-medium text-muted">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-200 dark:border-zinc-700 border-t-pink-500" />
              Loading…
            </div>
          ) : connected ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-teal-400" />
                <span className="text-sm font-bold text-teal-600 dark:text-teal-300">Connected</span>
              </div>
              <p className="text-sm font-medium text-muted">
                Your Stripe restricted API key is stored and encrypted with AES-256-GCM.
              </p>

              {error && (
                <p className="rounded-2xl border-2 border-pink-500/40 bg-pink-500/10 px-4 py-2.5 text-sm font-bold text-pink-600 dark:text-pink-400">
                  {error}
                </p>
              )}

              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="rounded-full border-2 border-pink-500 px-6 py-2.5 text-xs font-extrabold uppercase tracking-widest text-pink-500 dark:text-pink-400 hover:bg-pink-500 hover:text-white dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect Stripe'}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
                <span className="text-sm font-bold text-zinc-500 dark:text-zinc-400">Not connected</span>
              </div>
              <p className="text-sm font-medium text-muted">
                Connect your Stripe account to start receiving churn insights.
              </p>
              <Link
                href="/onboarding"
                className="inline-block rounded-full bg-teal-400 px-6 py-3 text-xs font-extrabold uppercase tracking-widest text-white dark:text-zinc-950 shadow-[4px_4px_0px_0px_rgba(15,118,110,1)] dark:shadow-[4px_4px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-teal-500 dark:hover:bg-teal-400/80 transition-all"
              >
                Connect Stripe
              </Link>
            </div>
          )}
        </div>

        <div className="card mt-6">
          <h2 className="mb-1 text-2xl font-bold font-display text-zinc-900 dark:text-white transition-colors duration-500">
            Exit Survey
          </h2>
          <p className="mb-6 text-sm font-medium text-muted">
            The survey your churned customers receive. Preview it, or send yourself a test to see
            the full email-to-dashboard loop.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/api/survey/preview"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border-2 border-zinc-200 dark:border-zinc-700 px-6 py-3 text-xs font-extrabold uppercase tracking-widest text-zinc-600 dark:text-zinc-300 hover:border-zinc-900 dark:hover:border-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              Preview survey
            </a>
            <button
              onClick={handleSendTest}
              disabled={sendingTest}
              className="rounded-full bg-pink-500 px-6 py-3 text-xs font-extrabold uppercase tracking-widest text-white shadow-[4px_4px_0px_0px_rgba(159,18,57,1)] dark:shadow-[4px_4px_0px_0px_#f472b6] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-pink-600 dark:hover:bg-pink-500/80 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-x-0 disabled:translate-y-0"
            >
              {sendingTest ? 'Sending…' : 'Send me a test survey'}
            </button>
          </div>

          {testResult && (
            <p
              className={`mt-4 rounded-2xl border-2 px-4 py-2.5 text-sm font-bold ${
                testResult.ok
                  ? 'border-teal-400/60 bg-teal-400/10 text-teal-600 dark:text-teal-300'
                  : 'border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-400'
              }`}
            >
              {testResult.message}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
