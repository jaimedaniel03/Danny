import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Newsreader, Public_Sans } from 'next/font/google';
import { siteIndexable, publicBaseUrl } from '@/allset/env';
import { isLaunchReady } from '@/allset/content/facts';
import '@/styles/tokens.css';
import '@/styles/base.css';

// Weight axis only. The optical-size axis more than doubles the file
// (132 KB vs 58 KB) and it sits on the path to first paint.
const serif = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
});

const sans = Public_Sans({
  subsets: ['latin'],
  variable: '--font-public-sans',
  display: 'swap',
});

/**
 * Indexing needs two things: the operator saying yes (SITE_INDEXABLE=true)
 * and every launch-required business fact verified. Until both, search
 * engines are told to stay away — an insurance site that names no licensed
 * entity should not be findable.
 */
const indexable = siteIndexable() && isLaunchReady();

export const metadata: Metadata = {
  metadataBase: new URL(publicBaseUrl() ?? 'http://localhost:3000'),
  title: {
    default: 'All Set Check — life and health coverage, explained plainly',
    template: '%s · All Set Check',
  },
  description:
    'Understand your options. Protect your people. Choose what fits your budget. Plain-language help with life and health insurance for working families.',
  applicationName: 'All Set Check',
  robots: indexable
    ? { index: true, follow: true }
    : { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  openGraph: {
    type: 'website',
    siteName: 'All Set Check',
    locale: 'en_US',
  },
  twitter: { card: 'summary_large_image' },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: '#17323A',
  width: 'device-width',
  initialScale: 1,
  // No maximumScale: people must be able to zoom.
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
