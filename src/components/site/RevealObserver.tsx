'use client';

/**
 * One-time scroll reveals.
 *
 * Elements marked `data-reveal` are visible by default. On mount, this hides
 * only the ones that are still below the fold, then reveals each once as it
 * scrolls into view. So: no script, a failed script, an old browser, or
 * prefers-reduced-motion → nothing is ever hidden. Content above the fold
 * never flickers, and nothing animates twice.
 */

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

export function RevealObserver() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const fold = window.innerHeight * 0.92;
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]')).filter(
      (el) => !el.dataset['revealState'] && el.getBoundingClientRect().top > fold,
    );
    if (targets.length === 0) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          el.dataset['revealState'] = 'shown';
          observer.unobserve(el);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );

    for (const el of targets) {
      el.dataset['revealState'] = 'pending';
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      // Never leave anything hidden behind, e.g. on fast navigation.
      for (const el of targets) {
        if (el.dataset['revealState'] === 'pending') el.dataset['revealState'] = 'shown';
      }
    };
  }, [pathname]);

  return null;
}
