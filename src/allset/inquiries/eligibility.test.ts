import { describe, expect, it } from 'vitest';
import { parseFacts, type BusinessFacts } from '@/allset/content/facts';
import { checkEligibility } from './eligibility';
import type { ValidInquiry } from './fields';

const proof = { verifiedBy: 'Owner, state lookup', verifiedOn: '2026-09-01', source: 'DOI record' };

function facts(licenses: { state: string; lines: ('life' | 'health')[] }[], served: string[]): BusinessFacts {
  return parseFacts({
    legalEntity: null,
    licenses: licenses.map((l, i) => ({
      value: { state: l.state, holderType: 'individual', holder: 'A. Producer', licenseNumber: `L-${i}`, lines: l.lines },
      ...proof,
    })),
    npn: null,
    serviceArea: { value: { states: served }, ...proof },
    carriers: [],
    compensation: null,
    contact: { phone: null, email: null, mailingAddress: null, hours: null },
    founderStory: null,
    testimonials: [],
    proofPoints: [],
    teamRole: null,
    legalReview: null,
  });
}

function inquiry(over: Partial<ValidInquiry>): ValidInquiry {
  return {
    kind: 'coverage',
    fullName: 'Test Person',
    email: 'test@example.com',
    emailNormalized: 'test@example.com',
    zip: '60601',
    state: 'IL',
    contactMethod: 'email',
    phoneE164: null,
    coverageInterest: 'life',
    licensingStatus: null,
    disclosureAck: false,
    ...over,
  };
}

describe('eligibility', () => {
  const lifeInIl = facts([{ state: 'IL', lines: ['life'] }], ['IL']);

  it('takes requests only from served states', () => {
    expect(checkEligibility(inquiry({ state: 'IL' }), lifeInIl)).toEqual({ ok: true });
    const out = checkEligibility(inquiry({ state: 'WI' }), lifeInIl);
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/Wisconsin/) });
  });

  it('checks the license for each line asked about', () => {
    expect(checkEligibility(inquiry({ coverageInterest: 'health' }), lifeInIl)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/health insurance in Illinois/),
    });
    expect(checkEligibility(inquiry({ coverageInterest: 'both' }), lifeInIl)).toMatchObject({ ok: false });
    expect(checkEligibility(inquiry({ coverageInterest: 'not_sure' }), lifeInIl)).toEqual({ ok: true });
    const both = facts([{ state: 'IL', lines: ['life', 'health'] }], ['IL']);
    expect(checkEligibility(inquiry({ coverageInterest: 'both' }), both)).toEqual({ ok: true });
  });

  it('turns everyone away while no facts are verified', () => {
    const none = parseFacts({
      legalEntity: null, licenses: [], npn: null, serviceArea: null, carriers: [], compensation: null,
      contact: { phone: null, email: null, mailingAddress: null, hours: null },
      founderStory: null, testimonials: [], proofPoints: [], teamRole: null, legalReview: null,
    });
    expect(checkEligibility(inquiry({}), none)).toMatchObject({ ok: false });
    expect(checkEligibility(inquiry({ kind: 'team', coverageInterest: null, licensingStatus: 'studying' }), none)).toMatchObject({ ok: false });
  });

  it('lets team inquiries through from served states without a line check', () => {
    expect(checkEligibility(inquiry({ kind: 'team', coverageInterest: null, licensingStatus: 'not_licensed' }), lifeInIl)).toEqual({ ok: true });
  });
});
