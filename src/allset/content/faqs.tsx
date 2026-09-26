import type { ReactNode } from 'react';
import { FACTS } from './facts';

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  readonly answer: ReactNode;
}

/**
 * General answers only. Nothing here states a price, a response time, a
 * carrier, or anything else about the business that has not been verified;
 * the licensing answer appears only once licenses are on record.
 */
function buildHomeFaqs(): FaqItem[] {
  const items: FaqItem[] = [
    {
      id: 'work-coverage',
      question: 'I have life insurance through work. Do I need more?',
      answer: (
        <>
          <p>
            Maybe, maybe not. Coverage through an employer is often a set amount, commonly tied to
            about a year&rsquo;s pay, and it usually ends when you leave the job. We look at what you
            already have first. Sometimes it is enough, and we will tell you so.
          </p>
        </>
      ),
    },
    {
      id: 'term-vs-permanent',
      question: 'What is the difference between term and whole life?',
      answer: (
        <>
          <p>
            Term life covers you for a set number of years, such as 10, 20 or 30, and usually costs
            the least for the amount of coverage. Whole life and other permanent policies can last
            your entire life and cost considerably more each month.
          </p>
          <p>
            Some permanent policies build cash value, but it grows slowly, fees come out of it, and
            borrowing against it reduces what your family receives. It is not a substitute for
            savings.
          </p>
        </>
      ),
    },
    {
      id: 'tight-budget',
      question: 'What if I can only afford a little?',
      answer: (
        <>
          <p>
            Then we start small, or we don&rsquo;t start at all. Depending on your income and state,
            you may qualify for free or low-cost health coverage through Medicaid or CHIP (for
            children), or for help lowering the premium on a Marketplace plan. When one of those fits
            better than anything we could offer, we will point you to it.
          </p>
        </>
      ),
    },
    {
      id: 'health-questions',
      question: 'Will you ask about my health or my Social Security number?',
      answer: (
        <>
          <p>
            Not on this website. Our forms never ask for medical history, Social Security numbers or
            payment details. Some life insurance applications do ask health questions. If you decide
            to apply, those questions are part of the insurer&rsquo;s own application, and we will
            explain why each one is asked.
          </p>
        </>
      ),
    },
    {
      id: 'after-submit',
      question: 'What happens after I send the form?',
      answer: (
        <>
          <p>
            A person on our team reads it and contacts you the way you asked: email, a call or a
            text. You get a reference number when you submit, so you can mention it when we talk.
            You can ask us to stop contacting you at any time.
          </p>
        </>
      ),
    },
    {
      id: 'on-my-own',
      question: 'Can I shop for health insurance on my own?',
      answer: (
        <>
          <p>
            Yes. You can compare plans and enroll directly at{' '}
            <a href="https://www.healthcare.gov/" rel="noopener noreferrer">
              HealthCare.gov
            </a>{' '}
            or your state&rsquo;s marketplace, and free, trained helpers are available to assist. We
            are happy to explain anything you find there.
          </p>
        </>
      ),
    },
  ];

  const states = FACTS.serviceArea?.value.states;
  if (FACTS.licenses.length > 0 && states) {
    items.push({
      id: 'licensed',
      question: 'Are you licensed in my state?',
      answer: (
        <p>
          We are currently licensed to help families in {states.join(', ')}. License numbers are
          listed at the bottom of every page.
        </p>
      ),
    });
  }
  return items;
}

export const HOME_FAQS: readonly FaqItem[] = buildHomeFaqs();
