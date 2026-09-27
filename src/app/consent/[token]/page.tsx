/**
 * The consent page.
 *
 * A lead taps a link from a text message and lands here. This page is the
 * bottleneck for the entire business: every signature captured moves a lead
 * from the human queue to AI-dialable, permanently, for renewals and cross-sell
 * and every future campaign.
 *
 * It is deliberately plain. A consent page that looks like a marketing funnel
 * invites the argument that the disclosure was buried, and "clear and
 * conspicuous" is a legal standard the design either meets or doesn't. So: one
 * column, real text at a readable size, the disclosure adjacent to the checkbox
 * rather than behind a link, and no dark patterns anywhere near the decline path.
 */

import { notFound } from 'next/navigation';
import { verifyConsentToken, maskPhoneForDisplay } from '@/consent/tokens';
import { renderDisclosure } from '@/consent/disclosure-text';
import { loadProfileSafe } from '@/config/agency';
import { ConsentForm } from './consent-form';
import styles from './consent.module.css';

export const dynamic = 'force-dynamic';

// These URLs carry signed tokens tied to one person's phone number.
export const metadata = {
  // Danny's consent page belongs to the agency in agency.config.json, not
  // to All Set Check, so it must not inherit the site's title template.
  title: { absolute: 'Okay a follow-up call' },
  robots: { index: false, follow: false, nocache: true },
};

interface PageProps {
  readonly params: Promise<{ readonly token: string }>;
}

export default async function ConsentPage({ params }: PageProps) {
  const { token } = await params;
  const verdict = verifyConsentToken(token);

  if (!verdict.valid) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1 className={styles.h1}>
            {verdict.reason === 'expired' ? 'This link has expired' : 'This link isn’t valid'}
          </h1>
          <p className={styles.body}>
            {verdict.reason === 'expired'
              ? 'Links stay active for two weeks. Give us a call and we’ll send you a fresh one.'
              : 'Double-check the link from your message, or give us a call and we’ll sort it out.'}
          </p>
        </div>
      </main>
    );
  }

  // Without a profile there is no seller to name, so there is nothing valid to
  // render. Better a 404 than a form that captures consent for "Your Agency".
  const profile = loadProfileSafe();
  if (!profile) notFound();
  const agencyLegalName = profile.legalName;

  let disclosure;
  try {
    disclosure = renderDisclosure({
      agencyLegalName,
      phoneDisplay: maskPhoneForDisplay(verdict.payload.phoneE164),
    });
  } catch {
    // Unreviewed disclosure language. Better to show nothing than to capture
    // consent under text counsel has not seen.
    notFound();
  }

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <p className={styles.eyebrow}>{agencyLegalName}</p>
        <h1 className={styles.h1}>Okay a follow-up call</h1>
        <p className={styles.body}>
          You asked us to get back to you at{' '}
          <strong>{maskPhoneForDisplay(verdict.payload.phoneE164)}</strong>. We just need your
          okay before we do.
        </p>

        <ConsentForm
          token={token}
          checkboxLabel={disclosure.checkboxLabel}
          body={disclosure.body}
          footer={disclosure.footer}
        />
      </div>
    </main>
  );
}
