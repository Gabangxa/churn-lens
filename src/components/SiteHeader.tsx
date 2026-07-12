import Link from 'next/link';
import Wordmark from './Wordmark';
import ThemeToggle from './ThemeToggle';

/**
 * Marketing header shared by the landing and login pages. Anchor links are
 * root-relative so they work from any route, not just the landing page.
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
            className="font-bold text-sm tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 transition-colors"
          >
            Features
          </Link>
          <Link
            href="/#pricing"
            className="font-bold text-sm tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 transition-colors"
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className={`font-bold text-sm tracking-wide transition-colors ${
              active === 'login'
                ? 'text-zinc-900 dark:text-white'
                : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300'
            }`}
          >
            Log in
          </Link>
        </nav>
        <div className="flex items-center space-x-4">
          <ThemeToggle />
          <Link
            href="/onboarding"
            className="px-6 py-2.5 rounded-full border-2 border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 text-xs font-bold uppercase tracking-widest shadow-[4px_4px_0px_0px_#18181b] dark:shadow-[4px_4px_0px_0px_#f4f4f5] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] hover:bg-zinc-900 hover:text-white dark:hover:bg-zinc-100 dark:hover:text-black transition-all active:scale-95"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
