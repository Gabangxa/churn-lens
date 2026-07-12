import type { Metadata } from 'next';
import './globals.css';
import BackgroundBlobs from '@/components/BackgroundBlobs';

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
    <html lang="en" className="scroll-smooth dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <div className="min-h-screen h-screen flex flex-col relative overflow-hidden transition-colors duration-500 selection:bg-pink-500/30 dark:selection:bg-indigo-500/30">
          <BackgroundBlobs />

          {/* Main canvas — every page renders inside this rounded shell */}
          <div className="relative z-10 flex-1 flex flex-col max-w-[1400px] w-full mx-auto p-4 md:p-8 md:py-10 min-h-0">
            <div className="bg-white dark:bg-[#09090b] rounded-[2.5rem] shadow-2xl shadow-zinc-400/20 dark:shadow-black/80 flex-1 flex flex-col overflow-hidden border-4 border-white dark:border-zinc-900 relative transition-colors duration-500 min-h-0">
              <div className="flex-1 overflow-y-auto flex flex-col">{children}</div>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
