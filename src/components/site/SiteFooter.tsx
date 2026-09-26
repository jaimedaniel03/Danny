import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import { FACTS, businessName } from '@/allset/content/facts';
import { formatPhone } from '@/allset/content/format';
import styles from './SiteFooter.module.css';

const COLUMNS = [
  {
    heading: 'Coverage',
    links: [
      { href: '/coverage#life', label: 'Life insurance' },
      { href: '/coverage#health', label: 'Health insurance' },
      { href: '/coverage#affordability', label: 'Affordability first' },
      { href: '/coverage#what-we-offer', label: 'What we can help with' },
    ],
  },
  {
    heading: 'All Set Check',
    links: [
      { href: '/story', label: 'Our story' },
      { href: '/team', label: 'Join the team' },
      { href: '/contact', label: 'Contact' },
    ],
  },
  {
    heading: 'Policies',
    links: [
      { href: '/privacy', label: 'Privacy policy' },
      { href: '/terms', label: 'Terms of use' },
    ],
  },
] as const;

export function SiteFooter() {
  const { contact, licenses, npn, serviceArea, legalEntity } = FACTS;
  const hasContact = contact.phone || contact.email || contact.mailingAddress;
  const year = new Date().getFullYear();

  return (
    <footer className={`section--ink ${styles.footer}`}>
      <div className="container">
        <div className={styles.top}>
          <div className={styles.brand}>
            <Logo tone="paper" />
            <p className={styles.promise}>
              Plain answers about life and health coverage, sized to what your budget can carry.
            </p>
          </div>

          <nav aria-label="Footer" className={styles.columns}>
            {COLUMNS.map((column) => (
              <div key={column.heading}>
                <h2 className={styles.heading}>{column.heading}</h2>
                <ul role="list">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href} className={styles.link}>
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        {hasContact || licenses.length > 0 || serviceArea ? (
          <div className={styles.facts}>
            {hasContact ? (
              <div>
                <h2 className={styles.heading}>Reach us</h2>
                <ul role="list" className={styles.factList}>
                  {contact.phone ? (
                    <li>
                      <a href={`tel:${contact.phone.value}`} className={styles.link}>
                        {formatPhone(contact.phone.value)}
                      </a>
                    </li>
                  ) : null}
                  {contact.email ? (
                    <li>
                      <a href={`mailto:${contact.email.value}`} className={styles.link}>
                        {contact.email.value}
                      </a>
                    </li>
                  ) : null}
                  {contact.mailingAddress ? <li>{contact.mailingAddress.value}</li> : null}
                  {contact.hours ? <li>{contact.hours.value}</li> : null}
                </ul>
              </div>
            ) : null}
            {licenses.length > 0 ? (
              <div>
                <h2 className={styles.heading}>Licensing</h2>
                <ul role="list" className={styles.factList}>
                  {licenses.map((license) => (
                    <li key={`${license.value.state}-${license.value.licenseNumber}`}>
                      {license.value.holder}, {license.value.state} license #{license.value.licenseNumber} (
                      {license.value.lines.join(' and ')})
                    </li>
                  ))}
                  {npn ? <li>National Producer Number {npn.value}</li> : null}
                </ul>
              </div>
            ) : null}
            {serviceArea ? (
              <div>
                <h2 className={styles.heading}>Where we work</h2>
                <p className={styles.factList}>{serviceArea.value.states.join(', ')}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={styles.legal}>
          <p>
            The information on this site is general education, not legal, tax, financial or medical
            advice. Whether you qualify for coverage, what it costs and what it pays depend on the
            insurer, the plan, your state and, for many policies, your health history. Insurance is
            protection against specific risks. It is not an investment, a savings plan or a way to
            get out of debt.
          </p>
          <p>
            Photos are licensed stock images used for illustration. The people shown are models,
            not our clients or team.
          </p>
          <p>
            © {year} {legalEntity ? `${businessName()}. All Set Check is a brand of ${legalEntity.value.name}.` : 'All Set Check.'}
          </p>
        </div>
      </div>
    </footer>
  );
}
