import type { Metadata } from 'next';
import './globals.css';

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <body>{children}</body>
    </html>
  );
}
