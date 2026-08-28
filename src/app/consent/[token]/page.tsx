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
import { ConsentForm } from './consent-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly token: string }>;
}

export default async function ConsentPage({ params }: PageProps) {
  const { token } = await params;
  const verdict = verifyConsentToken(token);

  if (!verdict.valid) {
    return (
      <main style={styles.main}>
        <div style={styles.card}>
          <h1 style={styles.h1}>
            {verdict.reason === 'expired' ? 'This link has expired' : 'This link isn’t valid'}
          </h1>
          <p style={styles.body}>
            {verdict.reason === 'expired'
              ? 'Links stay active for two weeks. Give us a call and we’ll send you a fresh one.'
              : 'Double-check the link from your message, or give us a call and we’ll sort it out.'}
          </p>
        </div>
      </main>
    );
  }

  const agencyLegalName = process.env['AGENCY_LEGAL_NAME'] ?? 'Your Agency';

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
    <main style={styles.main}>
      <div style={styles.card}>
        <p style={styles.eyebrow}>{agencyLegalName}</p>
        <h1 style={styles.h1}>Okay a follow-up call</h1>
        <p style={styles.body}>
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

const styles = {
  main: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '2rem 1rem 4rem',
    background: '#f5f7fa',
    color: '#15181e',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    lineHeight: 1.6,
  },
  card: {
    maxWidth: '34rem',
    width: '100%',
    background: '#ffffff',
    border: '1px solid #dde3eb',
    borderRadius: '6px',
    padding: '2rem 1.75rem 2.25rem',
  },
  eyebrow: {
    margin: '0 0 0.75rem',
    fontSize: '0.75rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: '#626d7d',
    fontWeight: 600,
  },
  h1: {
    margin: '0 0 1rem',
    fontSize: '1.6rem',
    lineHeight: 1.2,
    letterSpacing: '-0.01em',
  },
  body: { margin: '0 0 1.5rem', fontSize: '1rem', color: '#3d4653' },
} as const;
