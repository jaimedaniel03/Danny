import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Photo } from '@/components/site/Photo';
import { Arrow } from '@/components/brand/Mark';
import { FACTS } from '@/allset/content/facts';
import styles from './story.module.css';

export const metadata: Metadata = {
  title: 'Our story',
  description:
    'Why All Set Check exists: helping working families understand coverage, protect what matters, and avoid premiums they can’t keep paying.',
  alternates: { canonical: '/story' },
};

interface Principle {
  readonly title: string;
  readonly body: ReactNode;
}

const PRINCIPLES: readonly Principle[] = [
  {
    title: 'Listen first.',
    body: (
      <>
        We start with your family, your monthly budget, and anything you already have, like coverage
        through work. You do most of the talking.
      </>
    ),
  },
  {
    title: 'Explain in plain words, including what a policy does not do.',
    body: (
      <>
        For every option, you hear what it pays for, what it leaves out, and what it costs each month.
        Every insurance word gets explained the first time it comes up.
      </>
    ),
  },
  {
    title: 'Essentials first, then a premium you can keep paying.',
    body: (
      <>
        Housing, food, utilities, transportation and childcare come first. Coverage protects you only
        while you keep paying for it, so the premium has to fit a tight month too.
      </>
    ),
  },
  {
    title: 'Point to free public help when it fits.',
    body: (
      <>
        Free or low-cost public programs are sometimes the better answer. If Medicaid or CHIP (the
        Children’s Health Insurance Program) may fit your family, or if{' '}
        <a href="https://www.healthcare.gov/" rel="noopener noreferrer">HealthCare.gov</a> or{' '}
        <a href="https://www.medicare.gov/" rel="noopener noreferrer">Medicare.gov</a> is the right place to start, we will say
        so, even when it means there is nothing for us to sell.
      </>
    ),
  },
  {
    title: 'Check in as life changes.',
    body: (
      <>
        A new baby, a new job, a move, a tighter budget. We check in so your coverage keeps up, and so
        a premium that has become hard to carry gets a second look before the policy lapses.
      </>
    ),
  },
  {
    title: 'Never sell insurance as wealth, an investment, or debt relief.',
    body: (
      <>
        Insurance protects against a specific risk. It is not a savings plan, an investment, or a way
        out of debt. Some permanent life policies build cash value: money inside the policy that grows
        slowly, after fees. Taking it out can shrink what your family receives. When we explain a
        policy like that, we explain its costs and limits too.
      </>
    ),
  },
  {
    title: 'No pressure.',
    body: (
      <>
        You can take everything home, talk it over with someone you trust, and decide later, or decide
        no. We won’t invent deadlines. If a real one applies, like an enrollment period for health
        coverage, we’ll tell you exactly what it is.
      </>
    ),
  },
];

export default function StoryPage() {
  const story = FACTS.founderStory;

  return (
    <>
      {/* ── Intro ────────────────────────────────────────────── */}
      <section className={styles.intro} aria-labelledby="story-title">
        <div className={`container ${styles.introGrid}`}>
          <div className={styles.introCopy}>
            <p className="eyebrow">Our story</p>
            <h1 id="story-title" className={styles.title}>
              Coverage should make sense before you pay for it.
            </h1>
            <p className="lede">
              All Set Check helps low- and middle-income families understand their coverage, protect
              what matters most, and avoid commitments they can’t afford.
            </p>
            <p className={styles.flow}>
              Listen
              <span className="visually-hidden">, then </span>
              <span className={styles.flowArrow} aria-hidden="true">
                →
              </span>
              Explain
              <span className="visually-hidden">, then </span>
              <span className={styles.flowArrow} aria-hidden="true">
                →
              </span>
              Check in
            </p>
          </div>

          <div className={styles.introMedia}>
            <Photo
              slug="grandmother-granddaughter"
              alt="An older woman in a mustard cardigan sips tea across a kitchen table from a young girl, with a teapot, lemons and a plate of pastries between them."
              sizes="(min-width: 60rem) 44vw, 100vw"
              priority
              className={styles.photo}
            />
          </div>
        </div>
      </section>

      {/* ── Why we exist ─────────────────────────────────────── */}
      <section className={`section ${styles.whySection}`} aria-labelledby="why-title">
        <div className={`container ${styles.why}`}>
          <header className={styles.whyHead} data-reveal>
            <p className="eyebrow">Why we exist</p>
            <h2 id="why-title">Understanding comes before buying.</h2>
          </header>

          <div className={styles.whyBody} data-reveal>
            <p>
              Insurance comes with its own language. A <strong>premium</strong> is the price you pay,
              usually every month, to keep a policy active. A <strong>deductible</strong> is what you
              pay for care before a health plan starts to share the cost. A <strong>lapse</strong> is
              when a policy ends because the payments stopped.
            </p>
            <p>
              When words like these go unexplained, it is easy to end up with too little protection, or
              with a policy that costs more than a family can keep paying. We think every family
              deserves to know what they are buying, what it costs each month, and what it will not do,
              before they sign anything.
            </p>

            <div className={styles.mission}>
              <p className={styles.missionLabel}>Our mission</p>
              <p className={styles.missionText}>
                To help low- and middle-income families understand coverage, protect what matters, and
                avoid commitments they can’t afford.
              </p>
            </div>

            <div>
              <h3 className={styles.prioritiesTitle}>What we put first</h3>
              <dl className={styles.priorities}>
                <div>
                  <dt>Education</dt>
                  <dd>Plain explanations, so the decision stays yours.</dd>
                </div>
                <div>
                  <dt>Affordability</dt>
                  <dd>Essentials come first. Coverage has to fit what is left, in a tight month too.</dd>
                </div>
                <div>
                  <dt>Follow-up</dt>
                  <dd>We check in as life changes, not only on the day a policy starts.</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      {/* ── Founders: only the founders' own, verified account ── */}
      {story ? (
        <section className="section section--tint" aria-labelledby="founders-title">
          <div className={`container ${styles.founders}`} data-reveal>
            <p className="eyebrow">The founders</p>
            <h2 id="founders-title">{story.value.headline}</h2>
            <div className={`prose ${styles.foundersProse}`}>
              {story.value.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
            <ul role="list" className={styles.founderList}>
              {story.value.founders.map((founder) => (
                <li key={founder.name}>
                  <strong>{founder.name}</strong>
                  <span className={styles.founderRole}>{founder.role}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {/* ── Principles ───────────────────────────────────────── */}
      <section className={story ? 'section' : 'section section--tint'} aria-labelledby="principles-title">
        <div className="container">
          <header className={styles.principlesHead} data-reveal>
            <p className="eyebrow">Our commitments</p>
            <h2 id="principles-title">How we work with every family</h2>
            <p className="lede muted">
              These are the rules we hold ourselves to, whether or not anyone buys anything.
            </p>
          </header>

          <ol role="list" className={styles.principles}>
            {PRINCIPLES.map((principle, index) => (
              <li key={principle.title} className={styles.principle} data-reveal>
                <span className={styles.principleNumber} aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3 className={styles.principleTitle}>{principle.title}</h3>
                <p className={styles.principleBody}>{principle.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── The founders' ambition, stated honestly ───────────── */}
      <section className="section section--ink" aria-labelledby="freedom-title">
        <div className={`container ${styles.freedom}`}>
          <div className={styles.freedomHead} data-reveal>
            <p className="eyebrow">Why the founders do this</p>
            <h2 id="freedom-title">What financial freedom means here</h2>
            <p className={styles.freedomLede}>
              Our founders are building All Set Check because they want financial freedom for their own
              families. That is their personal ambition, and we would rather tell you plainly than
              leave you to guess.
            </p>
          </div>

          <div className={styles.freedomBody} data-reveal>
            <h3 className={styles.notTitle}>What it does not mean</h3>
            <ul role="list" className={styles.notList}>
              <li>
                <strong>It is not a promise to you.</strong> No insurance policy delivers financial
                freedom. Insurance protects against a specific risk. It does not build wealth.
              </li>
              <li>
                <p>
                  <strong>It is not a promise to anyone who joins the team.</strong> Income from this
                  work is not guaranteed. The role, its costs and its risks are laid out in full before
                  anyone reaches out.
                </p>
                <Link href="/team#role-disclosures" className={`target ${styles.inkLink}`}>
                  Read the role disclosures <Arrow />
                </Link>
              </li>
              <li>
                <strong>It does not decide what we recommend.</strong> Your budget and your family’s
                needs do. If the right answer is a smaller policy, a public program, or nothing new at
                all, that is the answer you will get.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── Where to go next ─────────────────────────────────── */}
      <section className="section" aria-labelledby="next-title">
        <div className="container">
          <h2 id="next-title" className={styles.nextTitle} data-reveal>
            Where would you like to start?
          </h2>
          <div className={styles.paths}>
            <div className={styles.path} data-reveal>
              <h3>Questions about your coverage</h3>
              <p>
                Tell us a little about your family and how you’d like to be reached. A person on our
                team will follow up the way you asked. There’s nothing to buy by sending it.
              </p>
              <Link href="/contact" className="btn btn--primary">
                Start a coverage check <Arrow className="btn__arrow" />
              </Link>
            </div>
            <div className={styles.path} data-reveal>
              <h3>Interested in the work</h3>
              <p>
                Read what the role involves, including licensing, pay, costs and chargebacks, before you
                decide whether to reach out.
              </p>
              <Link href="/team" className="btn btn--secondary">
                Read about joining the team
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
