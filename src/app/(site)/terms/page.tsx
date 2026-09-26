import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Tick } from '@/components/brand/Mark';
import { FACTS, businessName } from '@/allset/content/facts';
import layout from '../page-layout.module.css';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Terms of use',
  description:
    'Ground rules for this site: general education, not advice; no guarantees of coverage or price; what sending a form does and doesn’t mean.',
  alternates: { canonical: '/terms' },
};

const LAST_UPDATED = { iso: '2026-09-26', label: 'September 26, 2026' } as const;

interface Section {
  readonly id: string;
  readonly title: string;
  readonly body: ReactNode;
}

/** How to reach us: verified channels only, else reply to our team. */
function ContactChannels() {
  const { email, mailingAddress } = FACTS.contact;
  const hasVerified = email !== null || mailingAddress !== null;
  return (
    <div className={styles.callout}>
      {hasVerified ? (
        <>
          <ul role="list" className={styles.channels}>
            {email ? (
              <li>
                Email:{' '}
                <a className="target" href={`mailto:${email.value}`}>
                  {email.value}
                </a>
              </li>
            ) : null}
            {mailingAddress ? <li>Mail: {mailingAddress.value}</li> : null}
          </ul>
          <p>
            You can also use the contact form on this site. It has no message box, so when a person
            on our team follows up, tell them what your question is about.
          </p>
          <p>
            <Link href="/contact" className="btn btn--secondary">
              Go to the contact form
            </Link>
          </p>
        </>
      ) : (
        // The contact form records consent to talk about coverage; it is not a channel for
        // questions about these terms, so it is not offered here as one.
        <p>
          Until direct contact details are listed here, reply to any message from our team or ask
          the person who contacts you.
        </p>
      )}
    </div>
  );
}

export default function TermsPage() {
  const name = businessName();

  const summary = [
    'This site offers general education about insurance, not personal advice.',
    'Insurers decide whether they will cover you and what it costs. For Medicaid, CHIP and Marketplace financial help, the government program decides. Your policy documents are what count.',
    'Sending a form asks a person to contact you. It doesn’t make you a client or buy anything.',
    'A team inquiry is not a job application or a job offer, and no income is guaranteed.',
    'Please use the site honestly, and stay out of our private staff system.',
  ];

  const sections: readonly Section[] = [
    {
      id: 'about-these-terms',
      title: 'About these terms',
      body: (
        <>
          <p>
            These terms apply when you use this website, which is run by {name} (“we” or “us”). By
            using the site, you agree to them. If you don’t agree, please don’t use the site.
          </p>
          <p>
            Our <Link href="/privacy">privacy policy</Link> explains what we collect when you send
            a form, and what we do with it.
          </p>
        </>
      ),
    },
    {
      id: 'education-not-advice',
      title: 'Education, not advice',
      body: (
        <>
          <p>
            Everything on this site is general education about life and health insurance. It is not
            legal, tax, financial or medical advice, and it is not a recommendation for your
            situation.
          </p>
          <p>
            Insurance rules differ from state to state and change over time, so something we
            describe may not apply to you. For advice about your own legal, tax, money or health
            questions, talk with a qualified professional.
          </p>
        </>
      ),
    },
    {
      id: 'no-guarantees',
      title: 'No guarantees about coverage',
      body: (
        <>
          <p>
            We can’t promise that you will qualify for any coverage, what it will cost, or that an
            application will be approved. Insurers decide whether they will cover you and what it
            costs. Their decisions often depend on your age, where you live, the plan you choose
            and, for many policies, your health history. For Medicaid, CHIP and Marketplace
            financial help, the government program decides.
          </p>
          <p>
            Any example of a price or a benefit on this site is there to explain an idea. It is not
            a quote. Only an insurer can give you a quote.
          </p>
        </>
      ),
    },
    {
      id: 'policy-documents',
      title: 'Your policy documents are what count',
      body: (
        <p>
          If you buy coverage, the policy or plan documents from the insurer decide what is covered,
          what isn’t, and what you pay. If anything on this site is different from those documents,
          the documents win. Read them, and ask the insurer about anything that isn’t clear.
        </p>
      ),
    },
    {
      id: 'sending-a-form',
      title: 'Sending us a form',
      body: (
        <>
          <p>
            Sending a form asks a person on our team to contact you. It does not make you our client,
            and it does not create an insurance policy or any other contract. No coverage starts
            until an insurer accepts an application and issues a policy. For a Marketplace plan,
            coverage starts only after you enroll and make your first payment.
          </p>
          <p>
            Agreeing to be contacted is not a condition of buying anything. We try to reply
            promptly, but we can’t guarantee how quickly we will respond.
          </p>
        </>
      ),
    },
    {
      id: 'team-inquiries',
      title: 'Team inquiries',
      body: (
        <>
          <p>
            The form on our <Link href="/team">join the team page</Link> lets you ask about joining
            the team. It is not a job application. Sending it is not an offer of work, and it does
            not mean a position is available.
          </p>
          <p>
            No income is guaranteed. Any role would come with its own written terms. Read them
            carefully before you agree to anything.
          </p>
        </>
      ),
    },
    {
      id: 'using-the-site',
      title: 'Using the site fairly',
      body: (
        <>
          <p>When you use this site, please don’t:</p>
          <ul>
            <li>send forms with bots, scripts or any other automated tool;</li>
            <li>give false information, or send a form in someone else’s name without their permission;</li>
            <li>
              try to get into our private staff system, or test, probe or get around the security
              of any part of the site;
            </li>
            <li>do anything that interferes with the site or overloads it.</li>
          </ul>
          <p>We may block or ignore submissions that break these rules.</p>
        </>
      ),
    },
    {
      id: 'other-websites',
      title: 'Links to other websites',
      body: (
        <p>
          We link to other websites, such as HealthCare.gov, because they can help you. We don’t run
          those sites and aren’t responsible for what they say or how they handle your information.
          Their own terms and privacy policies apply.
        </p>
      ),
    },
    {
      id: 'our-content',
      title: 'Our content and brand',
      body: (
        <>
          <p>
            The All Set Check name, logo and check mark, and the text and design of this site,
            belong to {name}. You’re welcome to read, print and share pages for your own
            non-commercial use. Please don’t copy or reuse them for anything else without our
            written permission.
          </p>
          <p>
            The photos on this site are licensed stock images. They belong to their photographers
            and licensors, and they can’t be reused from this site. The people in them are models.
          </p>
        </>
      ),
    },
    {
      id: 'no-warranties',
      title: 'No warranties',
      body: (
        <p>
          We work to keep this site accurate and available, but we provide it “as is.” We don’t
          promise that it will always be available, free of errors or up to date, or that its
          general information fits your situation.
        </p>
      ),
    },
    {
      id: 'limits-on-liability',
      title: 'Limits on our responsibility',
      body: (
        <p>
          As far as the law allows, {name} is not responsible for losses that come from relying on
          the general information on this site, from the site being unavailable, or from websites we
          link to. Nothing in these terms takes away any right you have that the law does not allow
          us to limit.
        </p>
      ),
    },
    {
      id: 'changes',
      title: 'Changes to these terms',
      body: (
        <p>
          We may update these terms. The date at the top of this page shows when they last changed.
          If you keep using the site after a change, the updated terms apply.
        </p>
      ),
    },
    {
      id: 'contact',
      title: 'Questions',
      body: (
        <>
          <p>If you have a question about these terms, we’re glad to answer it.</p>
          <ContactChannels />
        </>
      ),
    },
  ];

  return (
    <>
      <section className={`section ${layout.intro}`} aria-labelledby="terms-title">
        <div className="container">
          <p className="eyebrow">Policies</p>
          <h1 id="terms-title" className={layout.title}>
            Terms of use
          </h1>
          <p className="lede">The ground rules for using this website, in plain language.</p>
          <p className={styles.updated}>
            Last updated <time dateTime={LAST_UPDATED.iso}>{LAST_UPDATED.label}</time>
          </p>
        </div>
      </section>

      <div className={`container ${styles.layout}`}>
        <section className={styles.summary} aria-labelledby="summary-title">
          <h2 id="summary-title" className={styles.summaryTitle}>
            The short version
          </h2>
          <ul role="list" className={styles.summaryList}>
            {summary.map((line) => (
              <li key={line}>
                <Tick className={styles.tick} />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>

        <nav className={styles.toc} aria-labelledby="toc-title">
          <p id="toc-title" className={styles.tocTitle}>
            On this page
          </p>
          <ol role="list">
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className={`target ${styles.tocLink}`}>
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className={styles.body}>
          {sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className={`prose ${styles.sec}`}
              aria-labelledby={`${section.id}-title`}
            >
              <h2 id={`${section.id}-title`}>{section.title}</h2>
              {section.body}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
