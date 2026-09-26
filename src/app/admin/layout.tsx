import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import '@/styles/admin.css';

export const metadata: Metadata = {
  title: { default: 'Lead desk', template: '%s · Lead desk · All Set Check' },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

/**
 * Every admin page is rendered per request. The middleware's CSP allows only
 * scripts carrying that request's nonce, and a prerendered page has none, so
 * a static admin page would load with its scripts blocked.
 */
export default async function AdminRootLayout({ children }: { children: ReactNode }) {
  await connection();
  return <div className="admin">{children}</div>;
}
