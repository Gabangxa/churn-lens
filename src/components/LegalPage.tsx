import Link from 'next/link';
import type { ReactNode } from 'react';
import SiteHeader from '@/components/SiteHeader';
import { LEGAL, hasUnfilledPlaceholders } from '@/lib/legal';

/** Shared chrome and typography for the /legal/* documents. */
export default function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-full">
      <SiteHeader />

      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-16 md:px-8">
        {hasUnfilledPlaceholders() && (
          <div className="mb-10 rounded-3xl border-2 border-yellow-300 bg-yellow-300/20 dark:bg-yellow-300/10 px-6 py-4 text-sm font-bold text-yellow-800 dark:text-yellow-300">
            Draft — this document still contains unfilled placeholders and has not been
            reviewed by a lawyer. Do not rely on it. Fill in{' '}
            <code className="font-mono">src/lib/legal.ts</code> to remove this banner.
          </div>
        )}

        <h1 className="text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white md:text-5xl">
          {title}
        </h1>
        <p className="mt-4 text-base font-medium text-muted leading-relaxed">{intro}</p>
        <p className="mt-3 text-sm font-medium text-muted">
          Last updated: {LEGAL.lastUpdated}
        </p>

        <div className="mt-12 space-y-10">{children}</div>

        <div className="mt-16 border-t border-zinc-100 dark:border-zinc-800 pt-8 text-sm font-medium text-muted">
          <p>
            Questions about this document?{' '}
            <a
              href={`mailto:${LEGAL.privacyEmail}`}
              className="font-bold text-pink-500 dark:text-pink-400 hover:underline"
            >
              {LEGAL.privacyEmail}
            </a>
          </p>
          <div className="mt-4 flex gap-6">
            <Link href="/legal/privacy" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              Privacy
            </Link>
            <Link href="/legal/terms" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              Terms
            </Link>
            <Link href="/legal/dpa" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              Data Processing
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-xl font-bold font-display tracking-tight text-zinc-900 dark:text-zinc-100">
        {heading}
      </h2>
      <div className="space-y-4 text-sm font-medium text-muted leading-relaxed">{children}</div>
    </section>
  );
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Emphasised callout for the clauses a reader most needs to notice. */
export function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-3xl border-2 border-zinc-200 bg-[#f8f9fa] px-6 py-4 dark:border-zinc-800 dark:bg-[#18181b]">
      {children}
    </div>
  );
}
