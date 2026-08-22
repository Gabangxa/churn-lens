import Link from 'next/link';
import Wordmark from './Wordmark';
import ThemeToggle from './ThemeToggle';

/**
 * Marketing header shared by the landing and login pages.
 * Audit fix: nav links were zinc-400 on white (~2.6:1) — now zinc-600 for AA.
 */
export default function SiteHeader({ active }: { active?: 'login' }) {
  return (
    <header className="sticky top-0 z-40 bg-white/90 dark:bg-[#09090b]/90 backdrop-blur transition-colors duration-500">
      <div className="flex items-center justify-between px-8 md:px-12 py-6">
        <Link href="/">
          <Wordmark />
        </Link>
        <nav className="hidden md:flex items-center space-x-10">
          <Link
            href="/#features"
            className="font-bold text-sm tracking-wide text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
          >
            Features
          </Link>
          <Link
            href="/#pricing"
            className="font-bold text-sm tracking-wide text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className={`font-bold text-sm tracking-wide transition-colors ${
              active === 'login'
                ? 'text-zinc-900 dark:text-white'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            Log in
          </Link>
        </nav>
        <div className="flex items-center space-x-4">
          <ThemeToggle />
          <Link
            href="/onboarding"
            className="px-6 py-2.5 rounded-full border-2 border-teal-900 dark:border-teal-100 text-teal-900 dark:text-teal-100 text-xs font-bold uppercase tracking-widest shadow-[4px_4px_0px_0px_#134e4a] dark:shadow-[4px_4px_0px_0px_#ccfbf1] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-teal-900 hover:text-white dark:hover:bg-teal-100 dark:hover:text-teal-950 transition-all active:scale-95"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
