'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

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
    <div className="min-h-screen bg-surface-900">
      <nav className="sticky top-0 z-40 border-b border-surface-700 bg-surface-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-lg font-semibold tracking-tight">
            Churn<span className="text-brand-400">Lens</span>
          </Link>
          <div className="flex items-center gap-4 text-sm text-muted">
            <Link href="/dashboard" className="hover:text-zinc-100 transition-colors">
              Dashboard
            </Link>
            <span className="h-4 w-px bg-surface-600" />
            <span className="text-zinc-100 font-medium">Settings</span>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="mb-8 text-2xl font-bold text-zinc-50">Settings</h1>

        <div className="card">
          <h2 className="mb-1 text-lg font-semibold text-zinc-100">Stripe Connection</h2>
          <p className="mb-6 text-sm text-muted">
            Manage your Stripe integration. ChurnLens uses your restricted API key to listen for cancellation events.
          </p>

          {connected === null ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-surface-600 border-t-brand-400" />
              Loading…
            </div>
          ) : connected ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <span className="text-sm font-medium text-emerald-400">Connected</span>
              </div>
              <p className="text-sm text-muted">
                Your Stripe restricted API key is stored and encrypted with AES-256-GCM.
              </p>

              {error && (
                <p className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-sm text-red-400">
                  {error}
                </p>
              )}

              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-5 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect Stripe'}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-500" />
                <span className="text-sm font-medium text-zinc-400">Not connected</span>
              </div>
              <p className="text-sm text-muted">
                Connect your Stripe account to start receiving churn insights.
              </p>
              <Link
                href="/onboarding"
                className="inline-block rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition-colors"
              >
                Connect Stripe
              </Link>
            </div>
          )}
        </div>

        <div className="card mt-6">
          <h2 className="mb-1 text-lg font-semibold text-zinc-100">Exit Survey</h2>
          <p className="mb-6 text-sm text-muted">
            The survey your churned customers receive. Preview it, or send yourself a test to see
            the full email-to-dashboard loop.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/api/survey/preview"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-surface-600 px-5 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-surface-700 transition-colors"
            >
              Preview survey
            </a>
            <button
              onClick={handleSendTest}
              disabled={sendingTest}
              className="rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sendingTest ? 'Sending…' : 'Send me a test survey'}
            </button>
          </div>

          {testResult && (
            <p
              className={`mt-4 rounded-lg border px-4 py-2.5 text-sm ${
                testResult.ok
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                  : 'bg-red-500/10 border-red-500/20 text-red-400'
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
