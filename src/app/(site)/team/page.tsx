import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { InquiryForm } from '@/components/forms/InquiryForm';
import { initialInquiryState } from '@/components/forms/inquiry-initial';
import { submitTeamInquiry } from '@/allset/inquiries/actions';
import { consentWording, TEAM_DISCLOSURE_ACK } from '@/allset/inquiries/consent';
import { FACTS } from '@/allset/content/facts';
import { Photo } from '@/components/site/Photo';
import { Arrow, Tick } from '@/components/brand/Mark';
import layout from '../page-layout.module.css';
import styles from './team.module.css';

export const metadata: Metadata = {
  title: 'Join the team',
  description:
    'What insurance agent work generally involves — licensing, training, pay, costs and chargebacks — before you reach out. Not a job offer; no income is guaranteed.',
  alternates: { canonical: '/team' },
};

const NEXT_STEPS = [
  'A person on our team reads your inquiry.',
  'We contact you the way you chose, to talk about the work and answer your questions, including pay, costs and licensing.',
  'If it still makes sense to both of us, you get the specific terms in writing before you commit to anything. You can say no at any point.',
];

const ASK = [
  'Will I be an employee or an independent contractor?',
  'What will I pay, to whom, and when, before I earn anything?',
  'How is commission paid, and when can it be charged back?',
  'Who trains me, for how long, and does training cost anything?',
  'Will I be expected to buy leads, software or materials?',
  'Is anyone paid when I join, or for policies I sell?',
  'Will I be expected to recruit other agents?',
  'Will I be asked to buy a policy for myself or my family?',
  'Can I have all of this in writing?',
];

interface DisclosureProps {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly specific: boolean;
  readonly children: ReactNode;
}

function Disclosure({ id, index, title, specific, children }: DisclosureProps) {
  return (
    <li id={id} className={styles.disclosure} data-reveal>
      <div className={styles.disclosureHead}>
        <span className={styles.disclosureIndex} aria-hidden="true">
          {String(index).padStart(2, '0')}
        </span>
        <h3 className={styles.disclosureTitle}>{title}</h3>
        <p className={specific ? `${styles.tag} ${styles.tagSpecific}` : styles.tag}>
          {specific ? 'This team’s terms' : 'General information'}
        </p>
      </div>
      <div className={styles.disclosureBody}>{children}</div>
    </li>
  );
}

export default async function TeamPage() {
  // Every render mints a fresh idempotency key and form token.
  await connection();
  const consent = consentWording('team');
  const role = FACTS.teamRole?.value ?? null;
  const specific = role !== null;

  return (
    <>
      {/* ── Intro ────────────────────────────────────────────── */}
      <section className={styles.intro} aria-labelledby="team-title">
        <div className={`container ${styles.introGrid}`}>
          <div className={styles.introCopy}>
            <p className="eyebrow">Join the team</p>
            <h1 id="team-title" className={styles.title}>
              Help families make sense of their coverage.
            </h1>
            <p className="lede">
              The work is selling life and health insurance: listening first, explaining options in
              plain words, and following up as families’ lives change.
            </p>

            <div className={`notice notice--warning ${styles.upfront}`}>
              <p>
                <strong>This page is not a job offer.</strong> Sending the form below is an inquiry,
                not an application, and it does not sign you up for anything.
              </p>
              <p>
                <strong>This is a sales role.</strong> Roles like this usually pay by commission on
                policies sold, not a salary.
              </p>
              <p>
                <strong>No income is guaranteed.</strong>{' '}
                {specific
                  ? 'The role’s licensing, pay, costs and risks are laid out below, before the form.'
                  : 'Below, before the form, is general information about licensing, pay, costs and risks in this kind of work. This team’s own terms come in writing before you commit to anything.'}
              </p>
            </div>

            <div className={styles.actions}>
              <a href="#role-disclosures" className="btn btn--primary">
                Read about the work first <Arrow className="btn__arrow" />
              </a>
            </div>
          </div>

          <div className={styles.introMedia}>
            <Photo
              slug="training-workshop"
              alt="Adults seated in a bright classroom with notebooks open on their laps, several raising their hands to ask questions."
              sizes="(min-width: 60rem) 44vw, 100vw"
              priority
              className={styles.photo}
            />
          </div>
        </div>
      </section>

      {/* ── The work ─────────────────────────────────────────── */}
      <section className={`section ${styles.workSection}`} aria-labelledby="work-title">
        <div className={`container ${styles.work}`}>
          <header className={styles.workHead} data-reveal>
            <p className="eyebrow">The work</p>
            <h2 id="work-title">What the work looks like</h2>
          </header>

          <div className={styles.workBody} data-reveal>
            <dl className={styles.workList}>
              <div>
                <dt>Listen first</dt>
                <dd>
                  Learn who depends on a family, what coverage they already have (like a plan through
                  work), and what fits their monthly budget.
                </dd>
              </div>
              <div>
                <dt>Explain plainly</dt>
                <dd>
                  Walk through life and health options in everyday words: what each one pays for, what
                  it doesn’t, and what it costs every month. Sometimes the right answer is a free public
                  program, or nothing new at all.
                </dd>
              </div>
              <div>
                <dt>Follow up</dt>
                <dd>
                  When families want it, check in as life changes, such as a new baby, a new job or a
                  move, so coverage keeps up and a premium (the monthly price of a policy) that has
                  become hard to pay gets a second look.
                </dd>
              </div>
            </dl>
            <p className={styles.workNote}>
              <strong>What it is not:</strong> pressuring anyone, or selling insurance as an investment,
              a savings plan, or a way out of debt. Selling insurance also requires a state license,
              which is covered below.
            </p>
          </div>
        </div>
      </section>

      {/* ── Role disclosures: before any form ────────────────── */}
      <section id="role-disclosures" className="section section--tint" aria-labelledby="disclosures-title">
        <div className="container">
          <header className={styles.disclosuresHead} data-reveal>
            <p className="eyebrow">Role disclosures</p>
            <h2 id="disclosures-title">
              {specific
                ? 'Before you reach out: the role, in full'
                : 'Before you reach out: what this kind of work involves'}
            </h2>
            {role ? (
              <p className="lede">
                These are the terms for the <strong>{role.title}</strong> role. You will also get them in
                writing before you commit to anything.
              </p>
            ) : (
              <div className={`notice ${styles.generalNote}`}>
                <p className="notice__title">General information, not this team’s terms</p>
                <p>
                  The six items below describe how this kind of work often works in the insurance
                  industry. They are not this team’s specific terms. You will get the specific terms in
                  writing before you commit to anything.
                </p>
              </div>
            )}
          </header>

          <ol role="list" className={styles.disclosures}>
            <Disclosure id="role-relationship" index={1} title="Role & relationship" specific={specific}>
              {role ? (
                <>
                  <p>{role.relationship}</p>
                  {role.upline ? (
                    <p>
                      <strong>Upline</strong> (the agent or agency you would work under): {role.upline}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p>
                    Many insurance agents are independent contractors, not employees. They are paid by
                    commission, not a salary. Contractors usually pay their own taxes and business
                    costs. They don’t get employee benefits like health coverage or paid time off.
                  </p>
                  <p>
                    Some teams are set up so the agent or agency you work under, often called your
                    “upline,” earns a share of the commission on your sales. Ask who that would be,
                    how much of your commission they keep, and whether anyone is paid for recruiting
                    you.
                  </p>
                </>
              )}
            </Disclosure>

            <Disclosure id="role-licensing" index={2} title="Licensing" specific={specific}>
              {role ? (
                <p>{role.licensing}</p>
              ) : (
                <>
                  <p>
                    Selling life or health insurance requires a state license for each line you sell:
                    life, health, or both. The license makes you an insurance producer, the legal term
                    for a licensed agent. Until you are licensed for a line, you can’t sell that kind of
                    insurance.
                  </p>
                  <ul>
                    <li>Getting licensed usually involves a pre-licensing course and a state exam, with fees.</li>
                    <li>Many states also require a background check and fingerprinting.</li>
                    <li>You need a license in each state where you sell, not only the state you live in.</li>
                    <li>
                      To sell an insurance company’s policies, you usually also need an appointment:
                      that company’s approval to sell for it.
                    </li>
                    <li>
                      Selling Marketplace or Medicare plans also requires separate certification for
                      those plans.
                    </li>
                  </ul>
                </>
              )}
            </Disclosure>

            <Disclosure id="role-training" index={3} title="Training" specific={specific}>
              {role ? (
                <p>{role.training}</p>
              ) : (
                <>
                  <p>
                    Training varies widely from team to team. A pre-licensing course prepares you for the
                    state exam. Learning to explain coverage well, and to help a family choose what fits
                    their budget, is separate and takes time.
                  </p>
                  <p>
                    Ask what training is offered, who gives it, how long it lasts, and whether any of it
                    costs you money.
                  </p>
                </>
              )}
            </Disclosure>

            <Disclosure id="role-pay" index={4} title="Pay" specific={specific}>
              {role ? (
                <>
                  <p>{role.pay}</p>
                  <p>
                    <strong>No income is guaranteed.</strong>
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Many agent roles are paid by commission: a share of the premium on policies you sell.
                    There is often no base salary. For health plans, commission is often a flat dollar
                    amount for each person covered, each month, rather than a percentage.
                  </p>
                  <p>
                    Commission depends on policies that are actually sold and kept in force, meaning
                    still active with premiums being paid. So income can be low or zero, especially early
                    on, while you get licensed and learn the work.
                  </p>
                  <p className={styles.plain}>
                    <strong>No income is guaranteed.</strong> This page shows no income figures or
                    examples, because no one can promise what you would earn.
                  </p>
                </>
              )}
            </Disclosure>

            <Disclosure id="role-expenses" index={5} title="Expenses" specific={specific}>
              {role ? (
                <table className={styles.costs}>
                  <caption className="visually-hidden">Costs you would pay</caption>
                  <thead>
                    <tr>
                      <th scope="col">Cost</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {role.expenses.map((expense) => (
                      <tr key={expense.item}>
                        <th scope="row">{expense.item}</th>
                        <td>{expense.cost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <>
                  <p>In roles like this, agents often pay their own business costs. These can include:</p>
                  <ul>
                    <li>Pre-licensing course, exam and license application fees.</li>
                    <li>Background check or fingerprinting fees, where required.</li>
                    <li>Continuing education, to keep a license active.</li>
                    <li>
                      Errors-and-omissions insurance, which protects an agent if a client says the agent
                      made a professional mistake.
                    </li>
                    <li>
                      Sometimes leads (contact details for people who asked to hear about coverage),
                      software, or training materials.
                    </li>
                  </ul>
                  <p>Ask for a written list of every cost, with amounts, before you pay for anything.</p>
                </>
              )}
            </Disclosure>

            <Disclosure id="role-chargebacks" index={6} title="Chargebacks" specific={specific}>
              {role ? (
                <p>{role.chargebacks}</p>
              ) : (
                <>
                  <p>
                    Some insurers pay commission in advance, before all the premiums behind it have been
                    paid. If the policy is cancelled or lapses (stops because payments stopped) within a
                    set period, the insurer takes that commission back. This is called a chargeback.
                  </p>
                  <p className={styles.plain}>
                    <strong>A chargeback can leave an agent owing money back.</strong> Ask how long the
                    chargeback period is, and how any money owed would be collected.
                  </p>
                </>
              )}
            </Disclosure>
          </ol>

          <aside className={styles.ask} aria-labelledby="ask-title" data-reveal>
            <h3 id="ask-title" className={styles.askTitle}>
              Questions to ask any team, including ours
            </h3>
            <ol role="list" className={styles.askList}>
              {ASK.map((question) => (
                <li key={question}>
                  <Tick className={styles.askTick} />
                  <span>{question}</span>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </section>

      {/* ── Honest fit ───────────────────────────────────────── */}
      <section className="section" aria-labelledby="fit-title">
        <div className="container">
          <header className={styles.fitHead} data-reveal>
            <p className="eyebrow">An honest fit check</p>
            <h2 id="fit-title">Who this may fit, and who it may not</h2>
          </header>

          <div className={styles.fitLists}>
            <div className={styles.fitColumn} data-reveal>
              <h3 className={styles.fitTitle}>It may fit you if</h3>
              <ul role="list" className={styles.fitList}>
                <li>
                  <Tick className={styles.fitTick} />
                  <span>You would rather listen than talk someone into something.</span>
                </li>
                <li>
                  <Tick className={styles.fitTick} />
                  <span>You can explain things in plain words and stay patient with questions.</span>
                </li>
                <li>
                  <Tick className={styles.fitTick} />
                  <span>You are comfortable following up with families over months and years.</span>
                </li>
                <li>
                  <Tick className={styles.fitTick} />
                  <span>You are willing to study for a state licensing exam and keep learning after it.</span>
                </li>
                <li>
                  <Tick className={styles.fitTick} />
                  <span>You can handle uneven income, or have other income to rely on while you start.</span>
                </li>
              </ul>
            </div>

            <div className={styles.fitColumn} data-reveal>
              <h3 className={styles.fitTitle}>It may not fit you if</h3>
              <ul role="list" className={`${styles.fitList} ${styles.notFit}`}>
                <li>
                  <span>You need a steady, predictable paycheck right now.</span>
                </li>
                <li>
                  <span>You need a salary and employee benefits, which roles like this often don’t include.</span>
                </li>
                <li>
                  <span>You can’t afford upfront costs like licensing fees, or the risk of owing a chargeback.</span>
                </li>
                <li>
                  <span>You are hoping this work will get you out of debt quickly.</span>
                </li>
                <li>
                  <span>You would find it hard to tell a family they don’t need a policy.</span>
                </li>
              </ul>
            </div>
          </div>

          <p className={styles.fitNote} data-reveal>
            Neither list is a judgment. It is better to know now than after you have paid for a course.
          </p>
        </div>
      </section>

      {/* ── Inquiry form ─────────────────────────────────────── */}
      <section
        id="team-inquiry"
        className={`${layout.formSection} ${styles.inquiry}`}
        aria-labelledby="inquiry-title"
      >
        <div className="container">
          <header className={styles.inquiryHead}>
            <p className="eyebrow">Team inquiry</p>
            <h2 id="inquiry-title">Still interested? Send an inquiry.</h2>
            <p className="lede">
              It takes a couple of minutes. You’ll be asked to confirm that you have read the role
              disclosures above. Sending it doesn’t commit you to anything.
            </p>
          </header>
        </div>

        <div className={`container ${layout.formGrid}`}>
          <div className={layout.formColumn}>
            <InquiryForm
              action={submitTeamInquiry}
              initialState={initialInquiryState('team')}
              consentText={consent.text}
              disclosureAckText={TEAM_DISCLOSURE_ACK}
              successNextSteps={NEXT_STEPS}
            />
          </div>

          <aside className={layout.aside} aria-labelledby="team-next-title">
            <div>
              <h2 id="team-next-title" className={layout.asideTitle}>
                What happens next
              </h2>
              <ol role="list" className={layout.timeline}>
                {NEXT_STEPS.map((step, index) => (
                  <li key={step}>
                    <span className={layout.timelineNumber} aria-hidden="true">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className={layout.direct}>
              <h2 className={layout.asideTitle}>Looking for coverage instead?</h2>
              <p>Coverage questions go through a separate form.</p>
              <Link href="/contact" className={`target ${styles.more}`}>
                Start a coverage check <Arrow />
              </Link>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
