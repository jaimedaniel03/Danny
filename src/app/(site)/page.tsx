import Link from 'next/link';
import { Photo } from '@/components/site/Photo';
import { Arrow, Tick } from '@/components/brand/Mark';
import { FACTS } from '@/allset/content/facts';
import { HOME_FAQS } from '@/allset/content/faqs';
import { Faq } from '@/components/site/Faq';
import { JsonLd, organizationJsonLd } from '@/components/site/JsonLd';
import styles from './home.module.css';

export default function HomePage() {
  const story = FACTS.founderStory;
  const testimonials = FACTS.testimonials;

  return (
    <>
      <JsonLd data={organizationJsonLd()} />

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={`container ${styles.heroGrid}`}>
          <div className={styles.heroCopy}>
            <p className="eyebrow">Life and health coverage, explained plainly</p>
            <h1 id="hero-title" className={styles.heroTitle}>
              Are you{' '}
              <span className={styles.really}>
                really
                <svg className={styles.underline} viewBox="0 0 200 18" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                  <path d="M3 11 C 55 17, 120 3, 197 9" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
                </svg>
              </span>{' '}
              all set?
            </h1>
            <p className={styles.heroLede}>
              Understand your options. Protect your people. Choose what fits your budget.
            </p>
            <div className={styles.actions}>
              <Link href="/coverage" className="btn btn--primary">
                Explore coverage <Arrow className="btn__arrow" />
              </Link>
              <Link href="/team" className="btn btn--secondary">
                Join the team
              </Link>
            </div>
            <p className={styles.heroNote}>
              We start by listening. You decide what, if anything, happens next.
            </p>
          </div>

          <figure className={styles.heroMedia}>
            <Photo
              slug="hero-kitchen-table"
              alt="A couple at their kitchen table working through bills and paperwork with a calculator and a laptop."
              sizes="(min-width: 60rem) 46vw, 100vw"
              priority
              className={styles.heroPhoto}
            />
            <aside className={styles.checkCard} aria-label="The All Set check">
              <p className={styles.checkTitle}>The All Set check</p>
              <ul role="list" className={styles.checkList}>
                <li>
                  <Tick className={styles.checkTick} />
                  Would your family manage if your paycheck stopped?
                </li>
                <li>
                  <Tick className={styles.checkTick} />
                  Do you know what you pay before your health plan pays?
                </li>
                <li>
                  <Tick className={styles.checkTick} />
                  Could you keep paying for your coverage in a tight month?
                </li>
              </ul>
            </aside>
          </figure>
        </div>
      </section>

      {/* ── Life and health ──────────────────────────────────── */}
      <section className="section" aria-labelledby="protection-title">
        <div className="container">
          <header className={styles.sectionHead} data-reveal>
            <p className="eyebrow">Two kinds of protection</p>
            <h2 id="protection-title">Coverage that does a specific job.</h2>
            <p className="lede muted">
              Each kind of insurance protects against a particular risk. Knowing which risk you are
              covering is the first step to not overpaying for the wrong thing.
            </p>
          </header>

          <article className={styles.feature} aria-labelledby="life-title" data-reveal>
            <Photo
              slug="family-at-table"
              alt="Two adults and two young children at a kitchen table, drawing together."
              sizes="(min-width: 60rem) 50vw, 100vw"
              className={styles.featurePhoto}
            />
            <div className={styles.featureCopy}>
              <p className={styles.featureIndex} aria-hidden="true">01</p>
              <h3 id="life-title">Life insurance</h3>
              <p>
                Life insurance pays money to the people you name if you die while the policy is
                active. That money can stand in for the income your family counts on, cover a
                funeral, or give the people you leave time to adjust.
              </p>
              <ul role="list" className={styles.points}>
                <li>
                  <Tick className={styles.pointTick} />
                  <span>
                    <strong>Term life</strong> covers you for a set number of years, called the
                    term. It usually costs the least for the most coverage.
                  </span>
                </li>
                <li>
                  <Tick className={styles.pointTick} />
                  <span>
                    <strong>Permanent life</strong> is meant to last your whole life. It costs more.
                    Any cash value (money held inside the policy) builds slowly, fees come out of
                    it, and in some policies it can go down.
                  </span>
                </li>
              </ul>
              <Link href="/coverage#life" className={`target ${styles.more}`}>
                How life insurance works <Arrow />
              </Link>
            </div>
          </article>

          <article className={`${styles.feature} ${styles.featureFlip}`} aria-labelledby="health-title" data-reveal>
            <Photo
              slug="pediatric-visit"
              alt="A doctor with a tablet talking with a mother and her young son during a clinic visit."
              sizes="(min-width: 60rem) 50vw, 100vw"
              className={styles.featurePhoto}
            />
            <div className={styles.featureCopy}>
              <p className={styles.featureIndex} aria-hidden="true">02</p>
              <h3 id="health-title">Health insurance</h3>
              <p>
                Health insurance shares the cost of medical care. You pay a premium (the monthly
                price) every month. When you get care, you pay part of the cost &mdash; sometimes
                all of it until you reach your deductible (the amount you pay each year before the
                plan starts to share costs). Comprehensive plans, including every Marketplace plan,
                cap what you pay each year for covered care in their network. Short-term and
                fixed-indemnity plans may not.
              </p>
              <ul role="list" className={styles.points}>
                <li>
                  <Tick className={styles.pointTick} />
                  <span>
                    <strong>The premium</strong> is only part of the cost. What a doctor visit or
                    hospital stay costs you also depends on your deductible, your copays (a set dollar
                    amount for a visit or prescription) and your coinsurance (your percentage share of
                    a bill after the deductible).
                  </span>
                </li>
                <li>
                  <Tick className={styles.pointTick} />
                  <span>
                    <strong>The network</strong> is the group of doctors and hospitals your plan works
                    with. Care from them, called in-network care, costs you less.
                  </span>
                </li>
              </ul>
              <Link href="/coverage#health" className={`target ${styles.more}`}>
                How health plans work <Arrow />
              </Link>
            </div>
          </article>
        </div>
      </section>

      {/* ── Process ──────────────────────────────────────────── */}
      <section className="section section--tint" aria-labelledby="process-title">
        <div className="container">
          <header className={styles.processHead} data-reveal>
            <p className="eyebrow">How we work</p>
            <h2 id="process-title">
              Listen <span className={styles.arrow} aria-hidden="true">→</span> Explain{' '}
              <span className={styles.arrow} aria-hidden="true">→</span> Check in
            </h2>
          </header>

          <Photo
            slug="listening"
            alt="A young man holding a coffee cup, listening closely to an older man across a kitchen table."
            sizes="(min-width: 78rem) 74rem, 100vw"
            className={styles.processPhoto}
          />

          <ol role="list" className={styles.steps}>
            <li className={styles.step} data-reveal>
              <span className={styles.stepNumber} aria-hidden="true">1</span>
              <h3>Listen</h3>
              <p>
                We start with your family, your monthly budget, and anything you already have, like
                coverage through work. You do most of the talking.
              </p>
            </li>
            <li className={styles.step} data-reveal>
              <span className={styles.stepNumber} aria-hidden="true">2</span>
              <h3>Explain</h3>
              <p>
                We walk through the options that fit, in plain words: what each one pays for, what it
                doesn&rsquo;t, and what it costs every month. If the right answer is a public program
                or no new policy at all, we say so.
              </p>
            </li>
            <li className={styles.step} data-reveal>
              <span className={styles.stepNumber} aria-hidden="true">3</span>
              <h3>Check in</h3>
              <p>
                If you&rsquo;d like, we&rsquo;ll check in when life changes. If a premium gets hard
                to pay, tell us before you miss a payment, and we&rsquo;ll look at your options with
                you.
              </p>
            </li>
          </ol>
        </div>
      </section>

      {/* ── Affordability ────────────────────────────────────── */}
      <section className="section section--ink" id="affordability" aria-labelledby="afford-title">
        <div className={`container ${styles.afford}`}>
          <div className={styles.affordCopy} data-reveal>
            <p className="eyebrow">Our affordability commitment</p>
            <h2 id="afford-title">Essentials first. Then a premium you can keep paying.</h2>
            <p className={styles.affordLede}>
              Coverage protects you only while you keep paying for it. A policy that squeezes the
              grocery budget tends to lapse, and a lapsed policy protects no one. So we work in this
              order:
            </p>
            <ol role="list" className={styles.order}>
              <li>
                <span className={styles.orderNumber} aria-hidden="true">1</span>
                <span>
                  <strong>Essentials.</strong> Housing, food, utilities, transportation, childcare.
                </span>
              </li>
              <li>
                <span className={styles.orderNumber} aria-hidden="true">2</span>
                <span>
                  <strong>A cushion.</strong> Even a small one, for the surprises every family gets.
                </span>
              </li>
              <li>
                <span className={styles.orderNumber} aria-hidden="true">3</span>
                <span>
                  <strong>Protection that fits what&rsquo;s left.</strong> Health and life coverage
                  with premiums you could still pay in a tight month.
                </span>
              </li>
            </ol>

            <h3 className={styles.wontTitle}>What we won&rsquo;t do</h3>
            <ul role="list" className={styles.wont}>
              <li>
                <Tick className={styles.wontTick} />
                Sell insurance as an investment, a savings plan, or a way to build wealth.
              </li>
              <li>
                <Tick className={styles.wontTick} />
                Tell you a policy will get you out of debt.
              </li>
              <li>
                <Tick className={styles.wontTick} />
                Recommend a premium that crowds out your essentials.
              </li>
              <li>
                <Tick className={styles.wontTick} />
                Rush you. You can take everything home and think it over.
              </li>
            </ul>
          </div>
          <Photo
            slug="reviewing-bills"
            alt="A mother and her teenage daughter at a kitchen table going over bills, with a calculator and a phone."
            sizes="(min-width: 60rem) 34vw, 100vw"
            className={styles.affordPhoto}
          />
        </div>
      </section>

      {/* ── Why we exist / founder story ─────────────────────── */}
      <section className="section" aria-labelledby="why-title">
        <div className="container">
        <div className={styles.why} data-reveal>
          {story ? (
            <>
              <p className="eyebrow">Our story</p>
              <h2 id="why-title">{story.value.headline}</h2>
              <p className="lede">{story.value.paragraphs[0]}</p>
              <p className="muted">
                {story.value.founders.map((f) => `${f.name}, ${f.role}`).join(' · ')}
              </p>
            </>
          ) : (
            <>
              <p className="eyebrow">Why All Set Check exists</p>
              <h2 id="why-title">Plain answers, for the families who need them most.</h2>
              <p className="lede">
                Insurance is full of words that make it hard to know what you are buying. We started
                All Set Check to explain it plainly, protect what matters most, and keep premiums
                inside the budget of low- and middle-income families.
              </p>
              <p className={styles.ambition}>
                Our founders are building this business because they want financial freedom for their
                own families. That is their goal. It is not a promise we make to you, and it is not
                something an insurance policy delivers.
              </p>
            </>
          )}
          <Link href="/story" className={`target ${styles.more}`}>
            Read our story <Arrow />
          </Link>
        </div>
        </div>
      </section>

      {/* ── Social proof: verified testimonials only ─────────── */}
      {testimonials.length > 0 ? (
        <section className="section section--tint" aria-labelledby="proof-title">
          <div className="container">
            <header className={styles.sectionHead}>
              <p className="eyebrow">In their words</p>
              <h2 id="proof-title">What families have told us</h2>
            </header>
            <div className={styles.quotes}>
              {testimonials.map((t) => (
                <figure key={t.value.permissionRecord} className={styles.quote} data-reveal>
                  <blockquote>
                    <p>&ldquo;{t.value.quote}&rdquo;</p>
                  </blockquote>
                  <figcaption>
                    <strong>{t.value.attribution}</strong>, {t.value.context}
                    {t.value.materialConnection ? <span className="fine-print"> — {t.value.materialConnection}</span> : null}
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className="fine-print">
              Shared with permission, in the person&rsquo;s own words. Individual experiences vary.
            </p>
          </div>
        </section>
      ) : null}

      {/* ── FAQ ──────────────────────────────────────────────── */}
      <section className="section section--tint" aria-labelledby="faq-title">
        <div className={`container ${styles.faqGrid}`}>
          <header data-reveal>
            <p className="eyebrow">Questions</p>
            <h2 id="faq-title">Common questions</h2>
            <p className="muted">
              Something else on your mind? <Link href="/contact">Send a coverage request</Link>, and
              ask the person who follows up.
            </p>
          </header>
          <Faq items={HOME_FAQS} />
        </div>
      </section>

      {/* ── Contact CTA ──────────────────────────────────────── */}
      <section className={`section ${styles.cta}`} aria-labelledby="cta-title">
        <div className="container">
        <div className={styles.ctaInner} data-reveal>
          <h2 id="cta-title">Find out if you&rsquo;re really all set.</h2>
          <p className="lede">
            Tell us a little about your family and how you&rsquo;d like to be reached. A person on
            our team will follow up the way you asked.
          </p>
          <div className={styles.actions}>
            <Link href="/contact" className="btn btn--primary">
              Start a coverage check <Arrow className="btn__arrow" />
            </Link>
            <Link href="/team" className="btn btn--secondary">
              Join the team
            </Link>
          </div>
        </div>
        </div>
      </section>
    </>
  );
}
