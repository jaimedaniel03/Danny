import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Photo } from '@/components/site/Photo';
import { Arrow, Tick } from '@/components/brand/Mark';
import { FACTS } from '@/allset/content/facts';
import styles from './coverage.module.css';

export const metadata: Metadata = {
  title: 'Life and health coverage, explained',
  description:
    'Life and health insurance in plain words: term vs. permanent life, deductibles, networks, who can get help paying, and why your budget comes first.',
  alternates: { canonical: '/coverage' },
};

/* ── Content ───────────────────────────────────────────────────────────────
 * General education only. The one set of dollar figures on this page is the
 * labeled, hypothetical worked example. Business specifics (licenses, states,
 * carriers) render only from verified FACTS.
 */

const TOC = [
  {
    id: 'life',
    number: '01',
    label: 'Life insurance',
    note: 'What it is for, the two main kinds, and what it is not.',
  },
  {
    id: 'health',
    number: '02',
    label: 'Health insurance',
    note: 'The words on a health plan, a worked example, and who can get help paying.',
  },
  {
    id: 'affordability',
    number: '03',
    label: 'Affordability first',
    note: 'Why your monthly budget comes before any policy.',
  },
  {
    id: 'what-we-offer',
    number: '04',
    label: 'What we can help with',
    note: 'And where to turn when we can’t.',
  },
] as const;

interface CompareRow {
  readonly label: string;
  readonly term: ReactNode;
  readonly permanent: ReactNode;
}

const COMPARE: readonly CompareRow[] = [
  {
    label: 'How long it lasts',
    term: <p>A set period, such as 10, 20 or 30 years.</p>,
    permanent: <p>Your whole life, as long as you keep paying what the policy needs.</p>,
  },
  {
    label: 'What it costs',
    term: <p>Usually the lowest premium for each dollar of coverage.</p>,
    permanent: <p>A much higher premium for the same death benefit.</p>,
  },
  {
    label: 'Money inside the policy',
    term: <p>None. Term life is protection only.</p>,
    permanent: (
      <p>
        Part of what you pay builds <dfn>cash value</dfn>: money held inside the policy. It builds
        slowly, fees come out of it, and in some policies it can go down. If you cancel early,{' '}
        <dfn>surrender charges</dfn> (fees for ending the policy) can take much of it.
      </p>
    ),
  },
  {
    label: 'Borrowing against it',
    term: <p>There is nothing to borrow against.</p>,
    permanent: (
      <p>
        You can borrow against the cash value. Loans charge interest. Any loan you don&rsquo;t pay
        back is taken out of the death benefit, so your family gets less. If the loan and interest
        grow larger than the cash value, the policy can end, and you may owe income tax.
      </p>
    ),
  },
  {
    label: 'When it ends',
    term: (
      <p>
        At the end of the term. If you outlive it, nothing is paid back. New coverage later usually
        costs more, because you are older.
      </p>
    ),
    permanent: <p>When you die. It can end sooner if you stop paying what the policy needs.</p>,
  },
];

const PLAN_TYPES = [
  {
    abbr: 'HMO',
    name: 'Health Maintenance Organization',
    text: (
      <>
        You pick a main doctor, called a primary care doctor. To see a specialist, you usually need a{' '}
        <dfn>referral</dfn>: an OK from that doctor. Care outside the network usually isn&rsquo;t
        covered, except in an emergency.
      </>
    ),
  },
  {
    abbr: 'PPO',
    name: 'Preferred Provider Organization',
    text: (
      <>
        You can see doctors in or out of the network, usually without a referral. Out-of-network care
        costs you more.
      </>
    ),
  },
  {
    abbr: 'EPO',
    name: 'Exclusive Provider Organization',
    text: (
      <>
        You must use doctors in the network, except in an emergency. You usually don&rsquo;t need a
        referral to see a specialist.
      </>
    ),
  },
] as const;

const OFFICIAL_HELP = [
  {
    href: 'https://www.healthcare.gov/',
    label: 'HealthCare.gov',
    note: 'Compare Marketplace plans and see if you can get help paying the premium.',
  },
  {
    href: 'https://www.medicaid.gov/',
    label: 'Medicaid.gov',
    note: 'Learn how Medicaid and CHIP work, and find your state’s program.',
  },
  {
    href: 'https://www.medicare.gov/',
    label: 'Medicare.gov',
    note: 'Learn when Medicare starts, what it covers, and how to sign up.',
  },
] as const;

const BEFORE_YOU_BUY = [
  'What does it pay for?',
  'What doesn’t it pay for?',
  'What will it cost every month, and can that cost go up?',
  'What happens if I miss a payment?',
  'Can I cancel? If I do, what happens to what I’ve paid?',
] as const;

type Line = 'life' | 'health';

const LINE_LABELS: Record<Line, string> = { life: 'Life insurance', health: 'Health insurance' };

/** States with a verified license for a line, from FACTS only. */
function licensedStates(line: Line): string[] {
  const states = new Set<string>();
  for (const license of FACTS.licenses) {
    if (license.value.lines.includes(line)) states.add(license.value.state);
  }
  return [...states].sort();
}

/** Decorative cross for the "is not" list; the text carries the meaning. */
function Cross({ className }: { readonly className?: string | undefined }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5 5 L15 15 M15 5 L5 15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export default function CoveragePage() {
  const licensedLines = (['life', 'health'] as const)
    .map((line) => ({ line, states: licensedStates(line) }))
    .filter((entry) => entry.states.length > 0);
  const { serviceArea, carriers } = FACTS;
  const hasVerifiedScope = licensedLines.length > 0 || serviceArea !== null || carriers.length > 0;

  return (
    <div className={styles.page}>
      {/* ── Intro ──────────────────────────────────────────────────────── */}
      <section className={styles.intro} aria-labelledby="coverage-title">
        <div className={`container ${styles.introGrid}`}>
          <div className={styles.introCopy}>
            <p className="eyebrow">Coverage</p>
            <h1 id="coverage-title" className={styles.title}>
              Coverage, explained{' '}
              <span className={styles.plainly}>
                plainly
                <svg
                  className={styles.underline}
                  viewBox="0 0 200 18"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M3 11 C 55 17, 120 3, 197 9" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
                </svg>
              </span>
              .
            </h1>
            <p className="lede">
              Life insurance and health insurance do different jobs. This page explains what each one
              does, what it doesn&rsquo;t do, and how to keep it affordable, in everyday words.
            </p>
            <p className={styles.introNote}>
              Read at your own pace. Each insurance word is explained the first time it shows up.
            </p>
          </div>

          <nav className={styles.toc} aria-labelledby="toc-title">
            <p id="toc-title" className={`eyebrow ${styles.tocLabel}`}>
              On this page
            </p>
            <ol role="list" className={styles.tocList}>
              {TOC.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`} className={styles.tocLink}>
                    <span className={styles.tocNumber} aria-hidden="true">
                      {item.number}
                    </span>
                    <span className={styles.tocText}>
                      <span className={styles.tocTitle}>{item.label}</span>
                      <span className={styles.tocNote}>{item.note}</span>
                    </span>
                    <Arrow className={styles.tocArrow} />
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </section>

      {/* ── Life insurance ─────────────────────────────────────────────── */}
      <section id="life" className="section" aria-labelledby="life-title">
        <div className="container">
          <header className={styles.sectionHead} data-reveal>
            <p className={`eyebrow ${styles.kicker}`}>
              <span className={styles.kickerNumber}>01</span> Life insurance
            </p>
            <h2 id="life-title">Life insurance protects the people who count on you.</h2>
            <p className={styles.sectionIntro}>
              Life insurance is a contract with an insurance company. The contract is called a{' '}
              <dfn>policy</dfn>. To keep it, you pay the company a set amount, usually every month.
              That payment is the <dfn>premium</dfn>. If you die while the policy is active, the
              company pays money to the people you chose. That money is the{' '}
              <dfn>death benefit</dfn>. The people who get it are your <dfn>beneficiaries</dfn>.
            </p>
          </header>

          <div className={styles.feature} data-reveal>
            <Photo
              slug="grandmother-granddaughter"
              alt="An older woman and a young girl having tea and snacks at a kitchen table."
              sizes="(min-width: 60rem) 45vw, 100vw"
              className={styles.featurePhoto}
            />
            <div className={styles.featureCopy}>
              <h3>What it can help with</h3>
              <p>The death benefit can help your family:</p>
              <ul role="list" className={styles.ticks}>
                <li>
                  <Tick className={styles.tick} />
                  <span>
                    <strong>Replace income they depend on</strong>, like the paycheck that covers rent
                    and groceries.
                  </span>
                </li>
                <li>
                  <Tick className={styles.tick} />
                  <span>
                    <strong>Pay final expenses</strong>, like a funeral and last medical bills.
                  </span>
                </li>
                <li>
                  <Tick className={styles.tick} />
                  <span>
                    <strong>Keep children&rsquo;s plans on track</strong>, like childcare, school or
                    staying in the same home.
                  </span>
                </li>
                <li>
                  <Tick className={styles.tick} />
                  <span>
                    <strong>Give a surviving partner time</strong> to grieve and adjust, instead of
                    making big decisions in a rush.
                  </span>
                </li>
              </ul>
              <p className="muted">
                It pays only if you die while the policy is active. How far the money goes depends
                on the amount of coverage and on what your family needs.
              </p>
            </div>
          </div>

          <div className={`${styles.block} ${styles.blockStacked}`} data-reveal>
            <div className={styles.blockHead}>
              <h3>Term or permanent: the two main kinds</h3>
              <p>
                <dfn>Term life</dfn> covers you for a set number of years, called the term.{' '}
                <dfn>Permanent life</dfn> is meant to last your whole life. Whole life and universal
                life are two common kinds of permanent life.
              </p>
            </div>
            <div className={styles.blockBody}>
              <table className={styles.compare} role="table">
                <caption className={styles.caption}>Term life and permanent life, side by side</caption>
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">
                      <span className="visually-hidden">What to compare</span>
                    </th>
                    <th scope="col" role="columnheader">
                      Term life
                    </th>
                    <th scope="col" role="columnheader">
                      Permanent life
                      <span className={styles.colNote}>Whole or universal life</span>
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {COMPARE.map((row) => (
                    <tr key={row.label} role="row">
                      <th scope="row" role="rowheader">
                        {row.label}
                      </th>
                      <td role="cell">
                        <span className={styles.cellLabel} aria-hidden="true">
                          Term life
                        </span>
                        {row.term}
                      </td>
                      <td role="cell">
                        <span className={styles.cellLabel} aria-hidden="true">
                          Permanent life
                        </span>
                        {row.permanent}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={styles.afterTable}>
                Cash value is not a substitute for savings. Fees, surrender charges and loans all
                reduce it.
              </p>
            </div>
          </div>

          <div className={styles.block} data-reveal>
            <div className={styles.blockHead}>
              <h3>Things to know before you apply</h3>
              <p className="muted">Keep these in mind before you sign anything.</p>
            </div>
            <div className={styles.blockBody}>
              <ul role="list" className={styles.notes}>
                <li>
                  <p className={styles.noteTitle}>Health questions can affect the price.</p>
                  <p>
                    The insurance company may ask about your health and habits. Some policies need a
                    short medical exam. This review is called <dfn>underwriting</dfn>. What it finds
                    can change your price, or whether you can get the policy at all.
                  </p>
                </li>
                <li>
                  <p className={styles.noteTitle}>Answer every question truthfully.</p>
                  <p>
                    Usually for the first two years, the insurer can check your answers when a claim
                    is made and may refuse to pay if something was wrong or left out.
                  </p>
                </li>
                <li>
                  <p className={styles.noteTitle}>You choose who gets the money.</p>
                  <p>
                    You can name one or more beneficiaries and usually change them later. Update them
                    after a marriage, divorce, birth or death. If you want to leave money to a young
                    child, ask how that works. Children usually can&rsquo;t receive it directly.
                  </p>
                </li>
                <li>
                  <p className={styles.noteTitle}>If payments stop, the protection stops.</p>
                  <p>
                    When premiums aren&rsquo;t paid, the policy <dfn>lapses</dfn>: it ends and pays
                    nothing. Ask how long the <dfn>grace period</dfn> is. That is the short window to
                    catch up after a missed payment.
                  </p>
                </li>
                <li>
                  <p className={styles.noteTitle}>Coverage through work may end with the job.</p>
                  <p>
                    Life insurance from an employer often stops when you leave, are laid off or retire.
                    Know what you have, and what happens to it if your job changes.
                  </p>
                </li>
              </ul>
            </div>
          </div>

          <aside className={styles.isNot} aria-labelledby="is-not-title" data-reveal>
            <h3 id="is-not-title" className={styles.isNotTitle}>
              What life insurance is not
            </h3>
            <ul role="list" className={styles.isNotList}>
              <li>
                <Cross className={styles.cross} />
                <span>
                  <strong>Not an investment.</strong> Any cash value builds slowly, fees come out of
                  it, and in some policies it can go down.
                </span>
              </li>
              <li>
                <Cross className={styles.cross} />
                <span>
                  <strong>Not a savings plan.</strong> Money you pay in can be hard to get back, and
                  surrender charges can take much of it.
                </span>
              </li>
              <li>
                <Cross className={styles.cross} />
                <span>
                  <strong>Not a way to build wealth.</strong> Its job is to protect the people who
                  depend on you.
                </span>
              </li>
              <li>
                <Cross className={styles.cross} />
                <span>
                  <strong>Not a way out of debt.</strong> It won&rsquo;t pay your bills while you are
                  alive, and the premium adds a monthly cost.
                </span>
              </li>
              <li>
                <Cross className={styles.cross} />
                <span>
                  <strong>Not guaranteed approval.</strong> The insurance company decides whether to
                  offer you a policy, and at what price.
                </span>
              </li>
            </ul>
          </aside>
        </div>
      </section>

      {/* ── Health insurance ───────────────────────────────────────────── */}
      <section id="health" className="section section--tint" aria-labelledby="health-title">
        <div className="container">
          <header className={styles.sectionHead} data-reveal>
            <p className={`eyebrow ${styles.kicker}`}>
              <span className={styles.kickerNumber}>02</span> Health insurance
            </p>
            <h2 id="health-title">Health insurance shares the cost of your care.</h2>
            <p className={styles.sectionIntro}>
              Health insurance helps pay for <dfn>covered care</dfn>: the doctor visits, hospital
              stays, tests and prescriptions your plan agrees to pay for. You pay part of the cost,
              and the plan pays part. A few words on every plan decide how that split works.
            </p>
          </header>

          <div className={`${styles.feature} ${styles.featureFlip} ${styles.featureTop}`} data-reveal>
            <Photo
              slug="pediatric-visit"
              alt="A doctor holding a tablet talks with a mother and her young son in a clinic exam room."
              sizes="(min-width: 60rem) 40vw, 100vw"
              className={styles.featurePhoto}
            />
            <div className={styles.featureCopy}>
              <h3>The words on your plan</h3>
              <dl className={styles.defs}>
                <div>
                  <dt>Premium</dt>
                  <dd>What you pay every month to keep the plan, even in months you don&rsquo;t see a doctor.</dd>
                </div>
                <div>
                  <dt>Deductible</dt>
                  <dd>
                    What you pay for covered care each year before the plan starts paying its share.
                    Some care, like certain checkups, may be covered before you reach it.
                  </dd>
                </div>
                <div>
                  <dt>Copay</dt>
                  <dd>
                    A set dollar amount you pay for certain services, like a doctor visit or a
                    prescription. Your plan lists each one.
                  </dd>
                </div>
                <div>
                  <dt>Coinsurance</dt>
                  <dd>
                    Your share of a bill after you reach your deductible, shown as a percentage. The
                    plan pays the rest.
                  </dd>
                </div>
                <div>
                  <dt>Out-of-pocket maximum</dt>
                  <dd>
                    The most you pay in a plan year for covered care from the plan&rsquo;s network
                    (more on networks below). Your deductible, copays and coinsurance count toward it.
                    Premiums don&rsquo;t. Once you reach it, the plan pays the full cost of covered
                    care for the rest of that year.
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Worked example: the only dollar amounts on the page, and labeled as made up. */}
          <figure className={styles.example} aria-labelledby="example-title" data-reveal>
            <div className={styles.exampleSetup}>
              <p className={styles.flag}>Example numbers, not a real plan</p>
              <h3 id="example-title">A worked example: one $3,000 bill</h3>
              <p>
                Say a plan has the numbers below, and you haven&rsquo;t paid anything toward the
                deductible yet this year. Then you get a bill for covered care from a doctor or
                hospital in the plan&rsquo;s network.
              </p>
              <dl className={styles.givens}>
                <div>
                  <dt>Deductible</dt>
                  <dd>$2,000</dd>
                </div>
                <div>
                  <dt>Coinsurance</dt>
                  <dd>20%</dd>
                </div>
                <div>
                  <dt>The bill</dt>
                  <dd>$3,000</dd>
                </div>
              </dl>
            </div>

            <div className={styles.exampleWork}>
              <ol role="list" className={styles.steps}>
                <li>
                  <span className={styles.stepNumber} aria-hidden="true">
                    1
                  </span>
                  <div>
                    <p>
                      <strong>You pay the deductible first.</strong> That is the first $2,000 of the
                      bill.
                    </p>
                    <p className={styles.math}>$3,000 − $2,000 = $1,000 left on the bill</p>
                  </div>
                </li>
                <li>
                  <span className={styles.stepNumber} aria-hidden="true">
                    2
                  </span>
                  <div>
                    <p>
                      <strong>You pay your coinsurance on what&rsquo;s left.</strong> Your share is
                      20% of the $1,000.
                    </p>
                    <p className={styles.math}>20% × $1,000 = $200</p>
                  </div>
                </li>
                <li>
                  <span className={styles.stepNumber} aria-hidden="true">
                    3
                  </span>
                  <div>
                    <p>
                      <strong>The plan pays the rest.</strong> That is the other 80% of the $1,000.
                    </p>
                    <p className={styles.math}>$1,000 − $200 = $800</p>
                  </div>
                </li>
              </ol>

              <dl className={styles.result}>
                <div>
                  <dt>You pay</dt>
                  <dd>
                    <span className={styles.resultSum}>$2,000 + $200 =</span>{' '}
                    <span className={styles.resultTotal}>$2,200</span>
                  </dd>
                </div>
                <div>
                  <dt>The plan pays</dt>
                  <dd>
                    <span className={styles.resultTotal}>$800</span>
                  </dd>
                </div>
              </dl>
              <p className={styles.check}>
                Check: $2,200 + $800 = $3,000, the whole bill.
              </p>
              <p className="fine-print">
                Monthly premiums are separate and are not part of this math. If your costs for the
                year reach the out-of-pocket maximum, you stop paying for covered, in-network care
                for the rest of that year.
              </p>
            </div>
          </figure>

          <div className={styles.block} data-reveal>
            <div className={styles.blockHead}>
              <h3>Networks: which doctors your plan pays for</h3>
              <p>
                Every plan works with a group of doctors, hospitals and pharmacies. That group is the
                plan&rsquo;s <dfn>network</dfn>. Care from the network, called{' '}
                <dfn>in-network</dfn> care, costs you less. <dfn>Out-of-network</dfn> care can cost
                much more, or may not be covered at all. Emergencies have their own rules.
              </p>
            </div>
            <div className={styles.blockBody}>
              <dl className={styles.planTypes}>
                {PLAN_TYPES.map((plan) => (
                  <div key={plan.abbr}>
                    <dt>
                      <span className={styles.planAbbr}>{plan.abbr}</span>
                      <span className={styles.planName}>{plan.name}</span>
                    </dt>
                    <dd>{plan.text}</dd>
                  </div>
                ))}
              </dl>
              <div className="notice">
                <p className="notice__title">Before you choose a plan</p>
                <p>
                  Check that your doctors, your hospital and your prescriptions are covered. Look them
                  up in the plan&rsquo;s list of doctors and its drug list, called a{' '}
                  <dfn>formulary</dfn>. Or call the plan and ask.
                </p>
              </div>
            </div>
          </div>

          <div className={styles.block} data-reveal>
            <div className={styles.blockHead}>
              <h3>What health plans may not cover</h3>
              <p>Even a good plan has limits. Look for these in the plan documents before you sign up.</p>
            </div>
            <div className={styles.blockBody}>
              <dl className={styles.defs}>
                <div>
                  <dt>Exclusions</dt>
                  <dd>Services the plan does not pay for at all. The plan documents list them.</dd>
                </div>
                <div>
                  <dt>Prior authorization</dt>
                  <dd>
                    For some care, the plan must approve it before you get it. Without that approval,
                    the plan may not pay.
                  </dd>
                </div>
                <div>
                  <dt>Drug formulary</dt>
                  <dd>
                    The plan&rsquo;s list of covered prescriptions. If your medicine isn&rsquo;t on
                    the list, you may pay much more for it.
                  </dd>
                </div>
              </dl>
              <div className="notice notice--warning">
                <p className="notice__title">Not everything sold as health coverage is full coverage.</p>
                <p>
                  <dfn>Short-term plans</dfn> are meant to fill a gap for a limited time.{' '}
                  <dfn>Fixed-indemnity plans</dfn> pay a set dollar amount per day or per service, no
                  matter what your care costs. Neither is <dfn>comprehensive coverage</dfn>: a plan
                  that pays for a wide range of care, such as doctor visits, hospital stays and
                  prescriptions. They may not cover <dfn>pre-existing conditions</dfn>, meaning health
                  problems you had before the plan started. They may also cap how much they pay. The
                  financial help for Marketplace plans, explained below, can&rsquo;t be used for
                  them. Health-care sharing ministries and discount cards aren&rsquo;t insurance at
                  all. Before you buy any of these, ask what would happen if you got seriously sick
                  or hurt.
                </p>
              </div>
            </div>
          </div>

          <div className={styles.block} data-reveal>
            <div className={styles.blockHead}>
              <h3>Who can get coverage, and when</h3>
              <p>
                Timing matters in health insurance. Missing a sign-up window can mean going without
                coverage until the next one.
              </p>
            </div>
            <div className={styles.blockBody}>
              <dl className={styles.defs}>
                <div>
                  <dt>Marketplace plans, and help paying</dt>
                  <dd>
                    The <dfn>Marketplace</dfn> is the official place to compare and buy your own
                    health plan, through HealthCare.gov or your state&rsquo;s own site. Many people
                    qualify for financial help that lowers their monthly premium. How much depends on
                    your income, household size and where you live. Some people with lower incomes
                    can also get lower deductibles and copays on Silver plans (one of the Marketplace
                    plan levels). The rules and amounts can change from year to year.
                  </dd>
                </div>
                <div>
                  <dt>Open enrollment</dt>
                  <dd>
                    Once a year, there is a set window to sign up for a Marketplace plan or change
                    plans. This is <dfn>open enrollment</dfn>. Plans through work have their own
                    yearly window. The dates vary by state and by year, so check them early.
                  </dd>
                </div>
                <div>
                  <dt>Special enrollment</dt>
                  <dd>
                    Outside that window, you can usually sign up only after a{' '}
                    <dfn>qualifying life event</dfn>. That is a change that opens a{' '}
                    <dfn>special enrollment</dfn> period, such as losing other coverage, moving to a
                    new area, getting married, or having or adopting a child. The time to act is
                    limited, so don&rsquo;t wait.
                  </dd>
                </div>
                <div>
                  <dt>Medicaid and CHIP</dt>
                  <dd>
                    <dfn>Medicaid</dfn> is free or low-cost health coverage run by each state, with
                    federal help. <dfn>CHIP</dfn>, the Children&rsquo;s Health Insurance Program,
                    covers children, and in some states pregnant people. Whether you qualify depends
                    on your income, household size and state, and sometimes on age, pregnancy or
                    disability. Some states are adding new rules, such as work requirements. Check
                    with your state. You can apply any time of year.
                  </dd>
                </div>
                <div>
                  <dt>Medicare</dt>
                  <dd>
                    <dfn>Medicare</dfn> is federal health insurance. It generally starts at age 65, or
                    earlier for people with certain disabilities or permanent kidney failure. It has
                    its own rules and sign-up periods. If you miss your first chance to sign up, you
                    may pay a late penalty for as long as you have Medicare. Your State Health
                    Insurance Assistance Program (SHIP) gives free, unbiased help. This site
                    doesn&rsquo;t cover choosing Medicare plans.
                  </dd>
                </div>
              </dl>

              <div id="official-help" className={styles.official}>
                <h4 className={styles.officialTitle}>Free, official help</h4>
                <p className="muted">
                  These are free government websites. You don&rsquo;t need an agent to use them.
                </p>
                <ul role="list" className={styles.officialList}>
                  {OFFICIAL_HELP.map((site) => (
                    <li key={site.href}>
                      <a href={site.href} rel="noopener noreferrer" className={`target ${styles.officialLink}`}>
                        {site.label} <Arrow />
                      </a>
                      <p>{site.note}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Affordability ──────────────────────────────────────────────── */}
      <section id="affordability" className="section section--ink" aria-labelledby="afford-title">
        <div className={`container ${styles.afford}`}>
          <div className={styles.affordCopy} data-reveal>
            <p className={`eyebrow ${styles.kicker}`}>
              <span className={styles.kickerNumber}>03</span> Affordability first
            </p>
            <h2 id="afford-title">Essentials and sustainable premiums come first.</h2>
            <p className={styles.affordLede}>
              Insurance protects you only while you keep paying for it. So we size coverage to fit
              your budget, not the other way around.
            </p>

            <h3 className={styles.affordSubhead}>How we size coverage</h3>
            <ol role="list" className={styles.order}>
              <li>
                <span className={styles.orderNumber} aria-hidden="true">
                  1
                </span>
                <span>
                  <strong>Start with the monthly budget.</strong> Essentials come first: housing,
                  food, utilities, transportation, childcare, and a small cushion for surprises.
                  Coverage has to fit in what&rsquo;s left.
                </span>
              </li>
              <li>
                <span className={styles.orderNumber} aria-hidden="true">
                  2
                </span>
                <span>
                  <strong>Pick a premium you could pay in a tight month.</strong> A smaller policy
                  you can keep beats a bigger one that lapses. A lapsed policy protects no one.
                </span>
              </li>
              <li>
                <span className={styles.orderNumber} aria-hidden="true">
                  3
                </span>
                <span>
                  <strong>Count what you already have.</strong> Coverage through work, Medicaid,
                  CHIP or help with Marketplace premiums may already meet some needs.
                </span>
              </li>
              <li>
                <span className={styles.orderNumber} aria-hidden="true">
                  4
                </span>
                <span>
                  <strong>Review it when life changes.</strong> A new baby, a new job, a move, a
                  raise or a pay cut. Health plans can usually be changed only during open
                  enrollment or after a qualifying life event. Adding life coverage usually means
                  answering health questions again.
                </span>
              </li>
            </ol>
          </div>

          <aside className={styles.askCard} aria-labelledby="ask-title" data-reveal>
            <h3 id="ask-title" className={styles.askTitle}>
              Questions to ask before you buy any policy
            </h3>
            <p className={styles.askNote}>From us or from anyone else. Write the answers down.</p>
            <ul role="list" className={styles.askList}>
              {BEFORE_YOU_BUY.map((question) => (
                <li key={question}>
                  <span className={styles.box} aria-hidden="true" />
                  <span>{question}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>

      {/* ── What we can help with ──────────────────────────────────────── */}
      <section id="what-we-offer" className="section" aria-labelledby="offer-title">
        <div className={`container ${styles.feature} ${styles.featureTop}`}>
          <Photo
            slug="family-at-table"
            alt="Two adults and two young children at a kitchen table, drawing together."
            sizes="(min-width: 60rem) 45vw, 100vw"
            className={styles.featurePhoto}
          />
          <div className={styles.featureCopy} data-reveal>
            <p className={`eyebrow ${styles.kicker}`}>
              <span className={styles.kickerNumber}>04</span> Where we fit in
            </p>
            <h2 id="offer-title">What we can help with</h2>
            <p>
              Which plans, insurance companies and prices you can choose from depends on where you
              live. It also depends on which states and kinds of insurance an agent is licensed for,
              and which insurance companies have approved the agent to sell their policies. A{' '}
              <dfn>carrier</dfn> is an insurance company. An <dfn>appointment</dfn> is a
              carrier&rsquo;s approval for an agent to offer its policies. You can look up any
              agent&rsquo;s license on your state insurance department&rsquo;s website.
            </p>

            {hasVerifiedScope ? (
              <dl className={styles.scope}>
                {licensedLines.map(({ line, states }) => (
                  <div key={line}>
                    <dt>{LINE_LABELS[line]}</dt>
                    <dd>Licensed in {states.join(', ')}</dd>
                  </div>
                ))}
                {serviceArea ? (
                  <div>
                    <dt>Where we take clients</dt>
                    <dd>{serviceArea.value.states.join(', ')}</dd>
                  </div>
                ) : null}
                {carriers.length > 0 ? (
                  <div>
                    <dt>Insurance companies we work with</dt>
                    <dd>
                      <ul role="list" className={styles.carrierList}>
                        {carriers.map((carrier) => (
                          <li key={carrier.value.name}>{carrier.value.name}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            <p>
              In your first conversation, a person on our team will tell you plainly what we can help
              with and what we can&rsquo;t. If we can&rsquo;t help, or a free public program fits you
              better, we will point you to it, including the{' '}
              <a href="#official-help">free official websites</a> listed above.
            </p>
            <ul role="list" className={styles.ticks}>
              <li>
                <Tick className={styles.tick} />
                <span>We listen first: your family, your budget, and any coverage you already have.</span>
              </li>
              <li>
                <Tick className={styles.tick} />
                <span>
                  We explain options in plain words: what each one pays for, what it doesn&rsquo;t, and
                  what it costs every month.
                </span>
              </li>
              <li>
                <Tick className={styles.tick} />
                <span>If the right answer is a public program or no new policy at all, we say so.</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── Closing CTA ────────────────────────────────────────────────── */}
      <section className="section section--tint" aria-labelledby="cta-title">
        <div className="container">
          <div className={styles.ctaInner} data-reveal>
            <h2 id="cta-title">Have a question about your own coverage?</h2>
            <p className="lede">
              Tell us a little about your family and how you&rsquo;d like to be reached. A person on our
              team will follow up the way you asked. There&rsquo;s nothing to buy by asking.
            </p>
            <div className={styles.actions}>
              <Link href="/contact" className="btn btn--primary">
                Start a coverage check <Arrow className="btn__arrow" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
