'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LEGAL_DOCS_VERSION } from '@/lib/legal-version';

/**
 * Asks an org with no acceptance of the current Terms/DPA on record to accept
 * them: the orgs that connected before acceptance was recorded, and every org
 * after LEGAL_DOCS_VERSION is bumped. Rendered by the dashboard only when
 * needed; it blocks nothing.
 *
 * The copy only says what is factually the case and links the documents — it
 * never summarises them, so it cannot drift from what they say.
 */
export default function LegalAcceptanceBanner({ previouslyAccepted }: { previouslyAccepted: boolean }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The version this banner was built with, so a banner left open across
        // a document update is refused rather than recorded against new text.
        body: JSON.stringify({ acceptedLegalVersion: LEGAL_DOCS_VERSION }),
      });
      if (res.status === 401) {
        router.push('/login?next=/dashboard');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        return;
      }
      // Hide now rather than waiting on the refresh; the refresh re-renders
      // the dashboard from the database, which no longer asks.
      setAccepted(true);
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (accepted) return null;

  // New tab, so the founder does not lose the dashboard while reading.
  const docLink = (href: string, label: string) => (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-bold text-teal-700 dark:text-teal-300 underline underline-offset-2 hover:text-teal-900 dark:hover:text-teal-200"
    >
      {label}
    </Link>
  );

  return (
    <div className="mt-6 rounded-3xl border-2 border-amber-500/40 bg-amber-500/10 px-6 py-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p id="legal-acceptance-text" className="text-sm font-medium text-zinc-800 dark:text-zinc-200 leading-relaxed">
          {previouslyAccepted
            ? 'The Terms of Service or Data Processing Agreement have changed since you accepted them. Please review and accept the current '
            : 'Please review and accept the '}
          {docLink('/legal/terms', 'Terms of Service')} and{' '}
          {docLink('/legal/dpa', 'Data Processing Agreement')}.
        </p>
        <button
          type="button"
          onClick={accept}
          disabled={saving}
          aria-describedby="legal-acceptance-text"
          className="shrink-0 rounded-full bg-teal-700 px-6 py-2.5 text-xs font-extrabold uppercase tracking-widest text-white hover:bg-teal-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'I agree'}
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm font-bold text-rose-700 dark:text-rose-400">{error}</p>
      )}
    </div>
  );
}
