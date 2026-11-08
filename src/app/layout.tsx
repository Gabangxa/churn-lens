import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';
import BackgroundBlobs from '@/components/BackgroundBlobs';

// Self-hosted fonts. next/font/google fetches these from Google once, at BUILD
// time, and serves them from /_next/static/media — so a visitor's browser
// (including a churned customer opening a survey link) never contacts Google
// and never hands it their IP address. The runtime Google Fonts @import this
// replaces did exactly that on every page, to a recipient the privacy policy
// does not name.
//
// Weights and display mirror that old @import exactly so rendering is
// unchanged: font-extrabold (800) still resolves to the 700 face, as it did
// before. Space Grotesk tops out at 700 — the old import asked for 800 and
// Google silently ignored it; next/font rejects it at build time instead.
// `subsets` only chooses what gets <link rel="preload">: every subset's
// @font-face is still self-hosted, so non-Latin text renders as it did.
//
// Each font is exposed as a CSS variable on <html>; tailwind.config.js builds
// the font-sans / font-display / font-mono stacks from these variables.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-space-grotesk',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

const fontVariables = `${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`;

export const metadata: Metadata = {
  title: {
    default: 'ChurnLens — Understand why customers leave',
    template: '%s | ChurnLens',
  },
  description:
    'Lightweight cancellation exit surveys with AI theme synthesis. Built for indie SaaS founders at $29/mo.',
  openGraph: {
    title: 'ChurnLens',
    description:
      'Understand why customers cancel — without paying enterprise prices.',
    url: 'https://churnlens.com',
    siteName: 'ChurnLens',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ChurnLens',
    description: 'Exit survey + AI theme synthesis for indie SaaS founders.',
  },
};

// Runs before paint so a stored light-mode preference doesn't flash dark.
// Dark is the default when nothing is stored.
const themeInitScript = `try{var t=localStorage.getItem('churnlens-theme');document.documentElement.classList.toggle('dark',t?t==='dark':true)}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${fontVariables} scroll-smooth dark`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <div className="min-h-screen flex flex-col relative transition-colors duration-500 selection:bg-teal-500/30 dark:selection:bg-teal-500/30">
          <BackgroundBlobs />

          {/* Main canvas — every page renders inside this rounded shell.
              The page scrolls normally (no inner scroller); the card uses
              overflow-clip, not overflow-hidden, so the sticky headers can
              track the viewport. */}
          <div className="relative z-10 flex-1 flex flex-col max-w-[1400px] w-full mx-auto p-4 md:p-8 md:py-10">
            <div className="bg-white dark:bg-[#09090b] rounded-[2.5rem] shadow-2xl shadow-zinc-400/20 dark:shadow-black/80 flex-1 flex flex-col overflow-clip border-4 border-white dark:border-zinc-900 relative transition-colors duration-500">
              <div className="flex-1 flex flex-col">{children}</div>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
