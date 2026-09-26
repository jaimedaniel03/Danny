import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SiteFooter } from '@/components/site/SiteFooter';
import { Arrow } from '@/components/brand/Mark';
import styles from './not-found.module.css';

export const metadata: Metadata = {
  title: 'Page not found',
  description: 'We couldn’t find that page. Try the home page, our coverage guide, or the contact form.',
};

const PLACES = [
  { href: '/', title: 'Home', text: 'Start from the beginning.' },
  { href: '/coverage', title: 'Coverage', text: 'How life and health insurance work, in plain words.' },
  { href: '/contact', title: 'Contact', text: 'Start a coverage check.' },
] as const;

/*
 * Rendered inside the root layout, not the (site) group layout, so it brings
 * its own header, footer, skip link and main landmark.
 */
export default function NotFound() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        <section className={styles.intro} aria-labelledby="not-found-title">
          <div className="container">
            <p className="eyebrow">Page not found</p>
            <h1 id="not-found-title" className={styles.title}>
              We couldn’t find that page.
            </h1>
            <p className="lede">
              The link may be out of date, or the address may have a typo in it. Here are a few
              good places to pick up from.
            </p>
            <ul role="list" className={styles.links}>
              {PLACES.map((place) => (
                <li key={place.href}>
                  <Link href={place.href} className={styles.link}>
                    <span className={styles.linkTitle}>{place.title}</span>
                    <span className={styles.linkText}>{place.text}</span>
                    <Arrow className={styles.arrow} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
