import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Tick } from '@/components/brand/Mark';
import { FACTS, businessName } from '@/allset/content/facts';
import { RETENTION } from '@/allset/retention';
import layout from '../page-layout.module.css';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'What All Set Check collects through its forms, why, who can see it, how long it is kept, and how to ask us to see, correct or delete your information.',
  alternates: { canonical: '/privacy' },
};

const LAST_UPDATED = { iso: '2026-09-26', label: 'September 26, 2026' } as const;

// Retention periods render from the same constants the purge job runs on,
// so the promise on this page and the practice cannot drift apart.
function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function monthsLabel(n: number): string {
  return n % 12 === 0 ? `${plural(n, 'month')} (${plural(n / 12, 'year')})` : plural(n, 'month');
}

interface Section {
  readonly id: string;
  readonly title: string;
  readonly body: ReactNode;
}

/**
 * Where privacy requests go: verified channels only. Without one, people reply
 * to a message from us instead. The contact form is not offered then: it has
 * no message box and would record a new consent.
 */
function RequestChannels() {
  const { email, mailingAddress } = FACTS.contact;
  const hasVerified = email !== null || mailingAddress !== null;
  return (
    <div className={styles.callout}>
      <h3>Privacy questions and requests</h3>
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
            on our team follows up, tell them you’re making a privacy request. You can also reply to
            any email or text message we send you.
          </p>
          <p>
            <Link href="/contact" className="btn btn--secondary">
              Go to the contact form
            </Link>
          </p>
        </>
      ) : (
        <p>
          Until a direct privacy contact is listed here, reply to any message from our team or tell
          the person who contacts you, and say it’s a privacy request.
        </p>
      )}
    </div>
  );
}

export default function PrivacyPage() {
  const operator = FACTS.legalEntity ? `${businessName()}, the business behind All Set Check` : 'All Set Check';

  const summary = [
    'We collect only what you type into our forms, plus a few technical details that help us stop spam and keep a record of your consent.',
    'We never ask for Social Security numbers, medical history or payment details on this site.',
    'A person on our team uses your information to reply the way you asked. We don’t sell it or use it for advertising.',
    `Requests are deleted automatically ${monthsLabel(RETENTION.leadMonthsAfterLastActivity)} after the last activity on them, or sooner if you ask.`,
    'You can ask to see, correct or delete your information, or ask us to stop contacting you, at any time.',
  ];

  const sections: readonly Section[] = [
    {
      id: 'who-we-are',
      title: 'Who we are',
      body: (
        <>
          <p>
            This policy explains how {operator} (“we” or “us”) handles information that people send
            through this website. It covers the two forms on this site, the coverage request on
            our <Link href="/contact">contact page</Link> and the inquiry on
            our <Link href="/team">join the team page</Link>, and the private system our team uses
            to follow up on them.
          </p>
          <RequestChannels />
        </>
      ),
    },
    {
      id: 'what-we-collect',
      title: 'What we collect',
      body: (
        <>
          <p>We collect as little as we can: what a person on our team needs to get back to you.</p>
          <h3>What you tell us in a form</h3>
          <ul>
            <li>Your name and email address.</li>
            <li>Your ZIP code.</li>
            <li>How you’d like us to reach you: email, phone call or text message.</li>
            <li>Your phone number, only if you choose a call or a text.</li>
            <li>
              On the coverage form, what you’d like help with: life insurance, health insurance,
              both, or not sure yet.
            </li>
            <li>
              On the team form, your licensing status, and your confirmation that you read the
              disclosures about the role.
            </li>
            <li>
              Your consent choice. We save the exact consent wording you saw, its version, which
              form you used and the time you agreed, so we can show what you agreed to.
            </li>
          </ul>
          <h3>What’s recorded automatically</h3>
          <ul>
            <li>
              A keyed one-way hash of your IP address (the number that identifies your internet
              connection). A hash is a scrambled code made from the address using a secret key. We
              keep the code, not the address itself.
            </li>
            <li>
              Your browser’s user-agent string: the short description every browser sends with a
              page request, such as which browser and operating system you use.
            </li>
          </ul>
          <p>We use these two details to prevent spam and abuse, and as part of the record of your consent.</p>
          <h3>What our team adds</h3>
          <p>
            Each request gets a reference number, like ASC-7K4M-2QXP. The people handling it record
            its status, follow-up dates and notes about our conversations with you. If you send a
            form again with the same email address, we add it to your open request instead of
            starting a new one.
          </p>
          <h3>What we don’t collect</h3>
          <p>
            We do not collect Social Security numbers, medical history or other health information,
            or payment details through this site. Please don’t send them to us, whether in a form,
            an email or a text message.
          </p>
        </>
      ),
    },
    {
      id: 'cookies',
      title: 'Cookies',
      body: (
        <>
          <p>
            A cookie is a small file a website stores in your browser. The public pages of this
            site set no advertising cookies and no analytics cookies, and we don’t use tracking
            pixels or similar tools.
          </p>
          <p>
            When someone on our team signs in to our private system, the site sets one cookie that
            is strictly necessary to keep them signed in. Visitors who don’t sign in never receive it.
          </p>
        </>
      ),
    },
    {
      id: 'how-we-use-it',
      title: 'How we use it',
      body: (
        <>
          <p>We use your information to:</p>
          <ul>
            <li>respond to your request the way you asked, by email, phone call or text message;</li>
            <li>keep a record that you agreed to be contacted, and of the exact words you agreed to;</li>
            <li>keep our forms free of spam and abuse;</li>
            <li>follow up as your request is handled, and keep track of what we’ve done.</li>
          </ul>
          <p>
            A person on our team contacts you. We don’t use your information for automated or
            prerecorded calls.
          </p>
          <p>
            We do not sell your personal information. We do not share it for cross-context
            behavioral advertising, meaning ads aimed at you based on what you do on other websites
            and apps.
          </p>
        </>
      ),
    },
    {
      id: 'who-can-see-it',
      title: 'Who can see it',
      body: (
        <>
          <h3>Our team</h3>
          <p>
            Only authorized members of our team can see your information, through a private system
            that requires a sign-in. Each person sees only what their role allows. For example, team
            members see requests assigned to them or not yet assigned, and only an owner of the
            business can export or delete records.
          </p>
          <h3>Companies that run our systems</h3>
          <p>
            We use service providers to host this website and our database. They store and process
            information for us so the site can work. Like any website host, the company that
            delivers these pages receives your IP address when your browser connects to it. Our
            hosting provider may keep records of these connections, including your IP address, in
            its own logs under its own policies.
          </p>
          <p>
            An email service sends our team an alert when a new request arrives. The alert contains
            only a reference number and the type of request. It never includes your name, email
            address, phone number or other personal details.
          </p>
          <h3>Insurers</h3>
          <p>
            Applying for insurance is a separate step. If you decide to apply, you’ll do that on the
            insurer’s own application, and the insurer’s privacy notice covers what you share there.
          </p>
          <h3>When the law requires it</h3>
          <p>We may disclose information if the law requires it, for example to comply with a court order.</p>
        </>
      ),
    },
    {
      id: 'how-long-we-keep-it',
      title: 'How long we keep it',
      body: (
        <>
          <p>We delete information on a schedule. A scheduled job removes records automatically once they reach these ages.</p>
          <table className={styles.table}>
            <caption className="visually-hidden">How long each kind of record is kept</caption>
            <thead>
              <tr>
                <th scope="col">Record</th>
                <th scope="col">How long we keep it</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Your requests and consent records</th>
                <td>
                  {monthsLabel(RETENTION.leadMonthsAfterLastActivity)} after the last activity on
                  your request
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Records of what our team did in the system, which identify requests by reference
                  number and never contain your contact details
                </th>
                <td>{plural(RETENTION.auditYears, 'year')}</td>
              </tr>
              <tr>
                <th scope="row">Records of alert emails sent to our team, which contain no personal details</th>
                <td>{monthsLabel(RETENTION.notificationMonths)}</td>
              </tr>
              <tr>
                <th scope="row">
                  Our do-not-contact list, which holds only keyed hashes of the email address and
                  phone number of people who asked us to stop contacting them
                </th>
                <td>{plural(RETENTION.suppressionYears, 'year')}</td>
              </tr>
              <tr>
                <th scope="row">Anti-spam counters, which hold only keyed hashes</th>
                <td>{plural(RETENTION.rateLimitDays, 'day')}</td>
              </tr>
            </tbody>
          </table>
          <p>
            If you ask us to delete your information, we delete it sooner. We may keep a minimal
            record that a deletion happened, without your contact details.
          </p>
          <p>Deleted records can stay in our database provider’s backups until those backups are replaced.</p>
        </>
      ),
    },
    {
      id: 'your-choices',
      title: 'Your choices',
      body: (
        <>
          <p>At any time, you can ask us to:</p>
          <ul>
            <li>
              <strong>Tell you what we have.</strong> We’ll tell you what information we hold about you.
            </li>
            <li>
              <strong>Correct it.</strong> If something is wrong, we’ll fix it.
            </li>
            <li>
              <strong>Delete it.</strong> We’ll delete your requests and consent records, as
              described in <a href="#how-long-we-keep-it">How long we keep it</a>.
            </li>
            <li>
              <strong>Stop contacting you.</strong> Reply STOP to any text from us, reply to any
              email from us, or tell the person who calls you. We’ll mark your record “Do not
              contact” so no one on our team contacts you about it. We also add a keyed hash of
              your email address and phone number to our do-not-contact list. If you ask us to
              delete your information too, that hash is the one thing we keep, so we can recognize
              your details and not contact you again if they reach us later.
            </li>
          </ul>
          <p>
            To make a request, use the ways to reach us listed under{' '}
            <a href="#who-we-are">Who we are</a>. We may need to confirm it’s really you before we
            share or change anything.
          </p>
          <p>
            Some U.S. states give their residents additional privacy rights. We honor the requests
            above no matter which state you live in, and we won’t treat you differently for making one.
          </p>
        </>
      ),
    },
    {
      id: 'security',
      title: 'Security',
      body: (
        <>
          <p>We take these steps to protect what you send us:</p>
          <ul>
            <li>Information travels between your browser and this site over an encrypted connection.</li>
            <li>
              Our team reaches your information only through a private system with access controls.
              Everyone must sign in, and each person sees only what their role allows.
            </li>
            <li>
              In our database, staff passwords, sign-in tokens and IP addresses are stored only as
              one-way hashes, never in their original form.
            </li>
            <li>Our own application logs leave out personal details such as names, email addresses and phone numbers.</li>
            <li>Alert emails to our team carry a reference number, never your details.</li>
          </ul>
          <p>
            We work to keep your information secure, but no website or storage system is perfectly
            secure, so we can’t promise that nothing will ever go wrong.
          </p>
        </>
      ),
    },
    {
      id: 'children',
      title: 'Children',
      body: (
        <p>
          This site is not directed to children under 13, and we don’t knowingly collect their
          information. If you believe a child has sent us information, let us know and we’ll delete it.
        </p>
      ),
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      body: (
        <p>
          We’ll update this policy when the way we handle information changes, and the date at the
          top of this page will show when it last changed. If we ever want to use information you’ve
          already sent us in a meaningfully different way, we’ll ask you first. Our{' '}
          <Link href="/terms">terms of use</Link> cover the rest of how this site works.
        </p>
      ),
    },
  ];

  return (
    <>
      <section className={`section ${layout.intro}`} aria-labelledby="privacy-title">
        <div className="container">
          <p className="eyebrow">Policies</p>
          <h1 id="privacy-title" className={layout.title}>
            Privacy policy
          </h1>
          <p className="lede">
            What we collect through this site, why, who can see it, and how long we keep it.
          </p>
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
