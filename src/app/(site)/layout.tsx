import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SiteFooter } from '@/components/site/SiteFooter';
import { RevealObserver } from '@/components/site/RevealObserver';
import { isLaunchReady } from '@/allset/content/facts';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      {isLaunchReady() ? null : (
        // Until the required business facts are verified, say so plainly on every page.
        <aside className="preview-bar" aria-label="Site status">
          <p>
            <strong>Preview.</strong> All Set Check is not open to the public yet. Licensing,
            service area and contact details are still being confirmed.
          </p>
        </aside>
      )}
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
      <RevealObserver />
    </>
  );
}
