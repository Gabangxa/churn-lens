'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Wordmark from '@/components/Wordmark';
import ThemeToggle from '@/components/ThemeToggle';

// Audit fixes: dirty-state save bar (unsaved edits are visible); test-send
// moved below the form with "uses saved settings" note; disconnect moved to a
// danger zone with inline two-step confirm (no native confirm()); logo URL
// live preview; "Saved." auto-dismisses; log out link in header.

const MAX_REASONS = 5;
const REASON_MAX_LEN = 60;
const DISPLAY_NAME_MAX_LEN = 60;
const LOGO_URL_MAX_LEN = 300;

type ReasonRow = { id: number; value: string };

type SurveyConfigField = 'displayName' | 'logoUrl' | 'customReasons';

export default function SettingsPage() {
  const router = useRouter();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const reasonIdCounter = useRef(0);
  const [configLoading, setConfigLoading] = useState(true);
  const [configLoadError, setConfigLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [logoBroken, setLogoBroken] = useState(false);
  const [reasons, setReasons] = useState<ReasonRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    ok: boolean;
    message: string;
    field?: SurveyConfigField;
  } | null>(null);
  // Snapshot of the last-saved config, for dirty detection.
  const [savedSnapshot, setSavedSnapshot] = useState('');

  function snapshot(name: string, url: string, rs: ReasonRow[]) {
    return JSON.stringify([name, url, rs.map((r) => r.value)]);
  }
  const dirty = !configLoading && snapshot(displayName, logoUrl, reasons) !== savedSnapshot;

  function nextReasonId() {
    reasonIdCounter.current += 1;
    return reasonIdCounter.current;
  }

  function applyConfig(data: { displayName: string | null; logoUrl: string | null; customReasons: string[] }) {
    const name = data.displayName ?? '';
    const url = data.logoUrl ?? '';
    const rs = (data.customReasons ?? []).map((value) => ({ id: nextReasonId(), value }));
    setDisplayName(name);
    setLogoUrl(url);
    setReasons(rs);
    setSavedSnapshot(snapshot(name, url, rs));
  }

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

  useEffect(() => {
    async function loadSurveyConfig() {
      setConfigLoadError(null);
      try {
        const res = await fetch('/api/settings/survey-config');
        if (res.status === 401) {
          router.push('/onboarding');
          return;
        }
        if (!res.ok) {
          setConfigLoadError('Could not load your survey settings.');
          return;
        }
        const data = await res.json();
        applyConfig(data);
      } catch {
        setConfigLoadError('Network error loading survey settings.');
      } finally {
        setConfigLoading(false);
      }
    }
    loadSurveyConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // "Saved." confirmation auto-dismisses.
  useEffect(() => {
    if (saveResult?.ok) {
      const t = setTimeout(() => setSaveResult(null), 4000);
      return () => clearTimeout(t);
    }
  }, [saveResult]);

  useEffect(() => setLogoBroken(false), [logoUrl]);

  function handleAddReason() {
    if (reasons.length >= MAX_REASONS) return;
    setReasons((prev) => [...prev, { id: nextReasonId(), value: '' }]);
  }

  function handleRemoveReason(id: number) {
    setReasons((prev) => prev.filter((r) => r.id !== id));
  }

  function handleReasonChange(id: number, value: string) {
    setReasons((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
  }

  async function handleSaveSurveyConfig() {
    setSaveResult(null);
    setSaving(true);
    try {
      const res = await fetch('/api/settings/survey-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim() === '' ? null : displayName,
          logoUrl: logoUrl.trim() === '' ? null : logoUrl,
          customReasons: reasons.map((r) => r.value).filter((v) => v.trim() !== ''),
        }),
      });
      if (res.status === 401) {
        router.push('/onboarding');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setSaveResult({
          ok: false,
          message: data.error || 'Failed to save survey settings.',
          field: data.field,
        });
        return;
      }
      applyConfig(data);
      setSaveResult({ ok: true, message: 'Saved.' });
    } catch {
      setSaveResult({ ok: false, message: 'Network error. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
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

  const inputClass = (field: SurveyConfigField) =>
    `w-full rounded-full border-2 bg-[#f8f9fa] dark:bg-[#18181b] px-5 py-3 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 transition-all focus:bg-white dark:focus:bg-[#121214] focus:outline-none ${
      saveResult && !saveResult.ok && saveResult.field === field
        ? 'border-rose-500 focus:border-rose-500'
        : 'border-zinc-200 dark:border-zinc-800 focus:border-teal-600'
    }`;

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
              className="font-bold text-sm tracking-wide text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
            >
              Dashboard
            </Link>
            <span className="font-bold text-sm tracking-wide text-zinc-900 dark:text-white">Settings</span>
          </nav>
          <div className="flex items-center space-x-4">
            <ThemeToggle />
            {/* A form, not a link: /api/auth/logout is POST-only so a
                third-party page cannot force a logout with a GET. */}
            <form action="/api/auth/logout" method="POST" className="contents">
              <button
                type="submit"
                className="text-sm font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-8 py-8 pb-16">
        <h1 className="mb-10 text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Settings
        </h1>

        {/* ── Survey customization ── */}
        <div className="card">
          <h2 className="mb-1 text-2xl font-bold font-display text-zinc-900 dark:text-white transition-colors duration-500">
            Exit Survey
          </h2>
          <p className="mb-6 text-sm font-medium text-muted">
            Add your product name, a logo, and extra cancellation reasons. Leave everything blank
            to keep the ChurnLens default.
          </p>

          {configLoading ? (
            <div className="flex items-center gap-2 text-sm font-medium text-muted">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-200 dark:border-zinc-700 border-t-teal-600" />
              Loading survey settings…
            </div>
          ) : configLoadError ? (
            <p className="rounded-2xl border-2 border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-700 dark:text-rose-400">
              {configLoadError}
            </p>
          ) : (
            <div className="space-y-5">
              <div>
                <label
                  htmlFor="survey-display-name"
                  className="mb-2 block text-sm font-bold text-zinc-900 dark:text-zinc-100"
                >
                  Display name
                </label>
                <input
                  id="survey-display-name"
                  type="text"
                  maxLength={DISPLAY_NAME_MAX_LEN}
                  placeholder="e.g. Acme Billing"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={inputClass('displayName')}
                />
                <p className="mt-2 text-xs font-medium text-muted">
                  Replaces the generic &quot;the team&quot; wording on the survey page and in the email
                  ({displayName.length}/{DISPLAY_NAME_MAX_LEN}).
                </p>
              </div>

              <div>
                <label
                  htmlFor="survey-logo-url"
                  className="mb-2 block text-sm font-bold text-zinc-900 dark:text-zinc-100"
                >
                  Logo URL
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="survey-logo-url"
                    type="url"
                    maxLength={LOGO_URL_MAX_LEN}
                    placeholder="https://yoursite.com/logo.png"
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                    className={inputClass('logoUrl')}
                  />
                  {/* Live preview — broken links show here, not on the customer's survey */}
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#f8f9fa] dark:bg-[#18181b]">
                    {logoUrl.trim() !== '' && !logoBroken ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external, org-supplied URL
                      <img
                        src={logoUrl}
                        alt="Logo preview"
                        className="h-full w-full object-contain"
                        onError={() => setLogoBroken(true)}
                      />
                    ) : (
                      <span className="font-mono text-[9px] text-zinc-400">{logoBroken ? '✕' : 'logo'}</span>
                    )}
                  </div>
                </div>
                <p className="mt-2 text-xs font-medium text-muted">
                  {logoBroken
                    ? "That URL didn't load — check it before saving."
                    : 'Must be an https link. Shown at the top of the survey page.'}
                </p>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    Custom cancellation reasons
                  </span>
                  <span className="text-xs font-medium text-muted">
                    {reasons.length}/{MAX_REASONS}
                  </span>
                </div>
                <p className="mb-3 text-xs font-medium text-muted">
                  Shown after the built-in reasons, with &quot;Other&quot; always last.
                </p>

                {reasons.length > 0 && (
                  <div className="mb-3 space-y-2">
                    {reasons.map((reason, idx) => (
                      <div key={reason.id} className="flex items-center gap-2">
                        <input
                          type="text"
                          maxLength={REASON_MAX_LEN}
                          placeholder={`Custom reason ${idx + 1}`}
                          aria-label={`Custom reason ${idx + 1}`}
                          value={reason.value}
                          onChange={(e) => handleReasonChange(reason.id, e.target.value)}
                          className={inputClass('customReasons')}
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveReason(reason.id)}
                          aria-label={`Remove custom reason ${idx + 1}`}
                          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 border-zinc-200 dark:border-zinc-700 text-sm font-bold text-zinc-400 dark:text-zinc-500 hover:border-rose-500 hover:text-rose-500 transition-colors"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleAddReason}
                  disabled={reasons.length >= MAX_REASONS}
                  className="rounded-full border-2 border-zinc-200 dark:border-zinc-700 px-5 py-2 text-xs font-extrabold uppercase tracking-widest text-zinc-600 dark:text-zinc-300 hover:border-zinc-900 dark:hover:border-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-zinc-200 dark:disabled:hover:border-zinc-700"
                >
                  + Add reason
                </button>
              </div>

              {/* Dirty-state save bar */}
              {dirty ? (
                <div className="flex items-center justify-between gap-3 rounded-2xl border-2 border-teal-400 bg-teal-400/10 px-4 py-3">
                  <span className="text-sm font-bold text-teal-800 dark:text-teal-300">Unsaved changes</span>
                  <button
                    type="button"
                    onClick={handleSaveSurveyConfig}
                    disabled={saving}
                    className="rounded-full bg-teal-700 px-6 py-2.5 text-xs font-extrabold uppercase tracking-widest text-white shadow-[3px_3px_0px_0px_#134e4a] dark:shadow-[3px_3px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[3px] hover:translate-y-[3px] hover:bg-teal-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              ) : saveResult?.ok ? (
                <p className="rounded-2xl border-2 border-teal-400/60 bg-teal-400/10 px-4 py-2.5 text-sm font-bold text-teal-700 dark:text-teal-300">
                  {saveResult.message}
                </p>
              ) : null}

              {saveResult && !saveResult.ok && (
                <p className="rounded-2xl border-2 border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-700 dark:text-rose-400">
                  {saveResult.message}
                </p>
              )}

              {/* Preview / test — below save, uses saved settings */}
              <div className="border-t border-zinc-100 dark:border-zinc-800 pt-5">
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
                    className="rounded-full border-2 border-zinc-200 dark:border-zinc-700 px-6 py-3 text-xs font-extrabold uppercase tracking-widest text-zinc-600 dark:text-zinc-300 hover:border-zinc-900 dark:hover:border-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sendingTest ? 'Sending…' : 'Send me a test survey'}
                  </button>
                </div>
                <p className="mt-2 text-xs font-medium text-muted">
                  Tests use your saved settings{dirty ? ' — you have unsaved changes above' : ''}.
                </p>

                {testResult && (
                  <p
                    className={`mt-4 rounded-2xl border-2 px-4 py-2.5 text-sm font-bold ${
                      testResult.ok
                        ? 'border-teal-400/60 bg-teal-400/10 text-teal-700 dark:text-teal-300'
                        : 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    {testResult.message}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Stripe connection ── */}
        <div className="card mt-6">
          <h2 className="mb-1 text-2xl font-bold font-display text-zinc-900 dark:text-white transition-colors duration-500">
            Stripe Connection
          </h2>
          <p className="mb-6 text-sm font-medium text-muted">
            ChurnLens uses your restricted API key to listen for cancellation events.
          </p>

          {connected === null ? (
            <div className="flex items-center gap-2 text-sm font-medium text-muted">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-200 dark:border-zinc-700 border-t-teal-600" />
              Loading…
            </div>
          ) : connected ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400">Connected</span>
              </div>
              <p className="text-sm font-medium text-muted">
                Your Stripe restricted API key is stored and encrypted with AES-256-GCM.
              </p>

              {error && (
                <p className="rounded-2xl border-2 border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-700 dark:text-rose-400">
                  {error}
                </p>
              )}

              {/* Danger zone with inline two-step confirm */}
              <div className="rounded-2xl border-2 border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 p-4">
                {!confirmDisconnect ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="m-0 text-sm font-medium text-rose-800 dark:text-rose-300">
                      <strong>Danger zone.</strong> Removes your key and all webhooks. Surveys stop immediately.
                    </p>
                    <button
                      onClick={() => setConfirmDisconnect(true)}
                      className="rounded-full border-2 border-rose-500 px-5 py-2 text-xs font-extrabold uppercase tracking-widest text-rose-700 dark:text-rose-400 hover:bg-rose-500 hover:text-white dark:hover:text-white transition-colors"
                    >
                      Disconnect…
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="m-0 text-sm font-bold text-rose-800 dark:text-rose-300">
                      This can&apos;t be undone. Disconnect Stripe?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmDisconnect(false)}
                        disabled={disconnecting}
                        className="rounded-full border-2 border-zinc-300 dark:border-zinc-600 px-4 py-2 text-xs font-extrabold uppercase tracking-widest text-zinc-600 dark:text-zinc-300 hover:border-zinc-500 transition-colors"
                      >
                        Keep it
                      </button>
                      <button
                        onClick={handleDisconnect}
                        disabled={disconnecting}
                        className="rounded-full bg-rose-600 px-4 py-2 text-xs font-extrabold uppercase tracking-widest text-white hover:bg-rose-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
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
                className="inline-block rounded-full bg-teal-700 px-6 py-3 text-xs font-extrabold uppercase tracking-widest text-white shadow-[4px_4px_0px_0px_#134e4a] dark:shadow-[4px_4px_0px_0px_#5eead4] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-teal-800 transition-all"
              >
                Connect Stripe
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
