'use client';

/**
 * Main navigation.
 *
 * Wide screens get an inline list. Narrow screens get a <details> disclosure,
 * which opens and closes with no JavaScript at all — so the menu works if
 * scripts fail, and there is no layout shift when they load. Script only adds
 * the niceties: Escape to close (returning focus to the button), closing when
 * a link is followed or a click lands outside, and aria-current.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { NAV_ITEMS } from './nav-items';
import styles from './SiteHeader.module.css';

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteNav() {
  const pathname = usePathname() ?? '/';
  const menu = useRef<HTMLDetailsElement>(null);

  // Close the menu after client-side navigation.
  useEffect(() => {
    if (menu.current?.open) menu.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const details = menu.current;
    if (!details) return undefined;

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && details?.open) {
        details.open = false;
        details.querySelector('summary')?.focus();
      }
    }
    function onPointer(event: PointerEvent) {
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  return (
    <nav aria-label="Main" className={styles.nav}>
      <ul role="list" className={styles.inline}>
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className={item.href === '/contact' ? `btn btn--primary ${styles.cta}` : styles.link}
              aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>

      <details ref={menu} className={styles.menu}>
        <summary className={styles.menuButton}>
          <span className={styles.menuIcon} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className={styles.menuLabel}>Menu</span>
        </summary>
        <div className={styles.panel}>
          <ul role="list" className={styles.stacked}>
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={styles.stackedLink}
                  aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
                  onClick={() => {
                    if (menu.current) menu.current.open = false;
                  }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </nav>
  );
}
