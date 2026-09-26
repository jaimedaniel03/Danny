import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/styles/admin.css';

export const metadata: Metadata = {
  title: { default: 'Lead desk', template: '%s · Lead desk · All Set Check' },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return <div className="admin">{children}</div>;
}
