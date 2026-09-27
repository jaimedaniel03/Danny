import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { InquiryForm } from '@/components/forms/InquiryForm';
import { initialInquiryState } from '@/components/forms/inquiry-initial';
import { submitCoverageInquiry } from '@/allset/inquiries/actions';
import { consentWording } from '@/allset/inquiries/consent';
import { FACTS } from '@/allset/content/facts';
import { formatPhone } from '@/allset/content/format';
import styles from '../page-layout.module.css';

export const metadata: Metadata = {
  title: 'Start a coverage check',
  description:
    'Start a coverage check. Tell us how to reach you and a person will follow up. No Social Security numbers or medical history needed.',
  alternates: { canonical: '/contact' },
};

const NEXT_STEPS = [
  'A person on our team reads your request.',
  'We contact you the way you chose, to listen first: your family, your budget, what you already have.',
  'If coverage makes sense, we explain the options that fit. If it doesn’t, we tell you that too.',
];

export default async function ContactPage() {
  // Every render mints a fresh idempotency key and form token.
  await connection();
  const consent = consentWording('coverage');
  const { contact } = FACTS;
  const hasDirect = contact.phone || contact.email;

  return (
    <>
      <section className={`section ${styles.intro}`} aria-labelledby="contact-title">
        <div className="container">
          <p className="eyebrow">Contact</p>
          <h1 id="contact-title" className={styles.title}>
            Start a coverage check.
          </h1>
          <p className="lede">
            Tell us a little about what you need and how to reach you. It takes about two minutes,
            and there&rsquo;s nothing to buy by sending it.
          </p>
        </div>
      </section>

      <section className={styles.formSection} aria-label="Coverage request form">
        <div className={`container ${styles.formGrid}`}>
          <div className={styles.formColumn}>
            <InquiryForm
              action={submitCoverageInquiry}
              initialState={await initialInquiryState('coverage')}
              consentText={consent.text}
              successNextSteps={NEXT_STEPS}
            />
          </div>

          <aside className={styles.aside} aria-labelledby="next-title">
            <h2 id="next-title" className={styles.asideTitle}>
              What happens next
            </h2>
            <ol role="list" className={styles.timeline}>
              {NEXT_STEPS.map((step, index) => (
                <li key={step}>
                  <span className={styles.timelineNumber} aria-hidden="true">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>

            {hasDirect ? (
              <div className={styles.direct}>
                <h2 className={styles.asideTitle}>Prefer to reach us directly?</h2>
                <ul role="list">
                  {contact.phone ? (
                    <li>
                      <a className="target" href={`tel:${contact.phone.value}`}>
                        {formatPhone(contact.phone.value)}
                      </a>
                    </li>
                  ) : null}
                  {contact.email ? (
                    <li>
                      <a className="target" href={`mailto:${contact.email.value}`}>
                        {contact.email.value}
                      </a>
                    </li>
                  ) : null}
                  {contact.hours ? <li className="muted">{contact.hours.value}</li> : null}
                </ul>
              </div>
            ) : null}

            <div className={styles.direct}>
              <h2 className={styles.asideTitle}>Interested in joining the team?</h2>
              <p>
                Team inquiries go through a separate form, after the role&rsquo;s pay, costs and
                licensing are laid out. <Link href="/team">Read about the role</Link>.
              </p>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
