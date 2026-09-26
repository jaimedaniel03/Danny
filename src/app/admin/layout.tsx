import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { databaseConfigured } from '@/allset/env';
import { Mark } from '@/components/brand/Mark';
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
  if (!databaseConfigured()) {
    // A preview deployed before its database exists: say so, rather than fail on every page.
    return (
      <div className="admin">
        <main id="main" className="container">
          <div className="auth-card">
            <Mark size={44} />
            <h1 className="admin-title">The lead desk isn’t connected yet</h1>
            <p>
              This deployment has no database, so no one can sign in and no requests are stored. The
              public forms stay closed until it is connected.
            </p>
          </div>
        </main>
      </div>
    );
  }
  return <div className="admin">{children}</div>;
}
