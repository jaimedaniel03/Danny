import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SiteFooter } from '@/components/site/SiteFooter';
import { RevealObserver } from '@/components/site/RevealObserver';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
      <RevealObserver />
    </>
  );
}
