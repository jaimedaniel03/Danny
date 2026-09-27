import { describe, expect, it } from 'vitest';
import { FACTS, isLaunchReady, launchChecklist, parseFacts, sellerName, type BusinessFacts } from './facts';

const proof = { verifiedBy: 'Owner, checked against the state lookup', verifiedOn: '2026-09-01', source: 'DOI lookup record 1' };

const EMPTY: BusinessFacts = {
  legalEntity: null,
  licenses: [],
  npn: null,
  serviceArea: null,
  carriers: [],
  compensation: null,
  contact: { phone: null, email: null, mailingAddress: null, hours: null },
  founderStory: null,
  testimonials: [],
  proofPoints: [],
  teamRole: null,
  legalReview: null,
};

function license(state: string, lines: ('life' | 'health')[]) {
  return { value: { state, holderType: 'individual' as const, holder: 'A. Producer', licenseNumber: `L-${state}`, lines }, ...proof };
}

describe('business facts', () => {
  it('ships with nothing claimed, so the site is not launch-ready', () => {
    expect(FACTS.licenses).toEqual([]);
    expect(FACTS.testimonials).toEqual([]);
    expect(isLaunchReady()).toBe(false);
    expect(sellerName()).toBe('All Set Check');
  });

  it('rejects a fact without its verification record', () => {
    expect(() => parseFacts({ ...EMPTY, npn: { value: '1234567' } })).toThrow();
    expect(() => parseFacts({ ...EMPTY, npn: { value: '1234567', ...proof, verifiedOn: 'last week' } })).toThrow();
    expect(parseFacts({ ...EMPTY, npn: { value: '1234567', ...proof } }).npn?.value).toBe('1234567');
  });

  it('rejects a service area that reaches beyond the licensed states', () => {
    const facts = { ...EMPTY, licenses: [license('IL', ['life'])], serviceArea: { value: { states: ['IL', 'IN'] }, ...proof } };
    expect(() => parseFacts(facts)).toThrow(/IN is in the service area but has no license/);
    const narrower = { ...facts, serviceArea: { value: { states: ['IL'] }, ...proof } };
    expect(parseFacts(narrower).serviceArea?.value.states).toEqual(['IL']);
  });

  it('requires both lines to be licensed before launch, since the site discusses both', () => {
    const lifeOnly = parseFacts({ ...EMPTY, licenses: [license('IL', ['life'])] });
    const both = parseFacts({ ...EMPTY, licenses: [license('IL', ['life']), license('IL', ['health'])] });
    const lines = (f: BusinessFacts) => launchChecklist(f).find((i) => i.key === 'lines')?.done;
    expect(lines(lifeOnly)).toBe(false);
    expect(lines(both)).toBe(true);
  });

  it('names the verified legal entity alongside the brand in consent wording', () => {
    const facts = parseFacts({
      ...EMPTY,
      legalEntity: { value: { name: 'Example Holdings LLC', entityType: 'LLC', formationState: 'IL' }, ...proof },
    });
    expect(sellerName(facts)).toBe('Example Holdings LLC (All Set Check)');
  });

  it('requires a licensed person in every served state before the licensing item is done', () => {
    const agencyOnly = parseFacts({
      ...EMPTY,
      licenses: [{ value: { state: 'IL', holderType: 'agency', holder: 'Example Agency', licenseNumber: 'A-1', lines: ['life'] }, ...proof }],
      serviceArea: { value: { states: ['IL'] }, ...proof },
    });
    const withPerson = parseFacts({
      ...agencyOnly,
      licenses: [...agencyOnly.licenses, license('IL', ['life'])],
    });
    const done = (f: BusinessFacts) => launchChecklist(f).find((i) => i.key === 'licenses')?.done;
    expect(done(agencyOnly)).toBe(false);
    expect(done(withPerson)).toBe(true);
  });

  it('records who verified each fact, when, and from what', () => {
    const facts = parseFacts({ ...EMPTY, npn: { value: '1234567', ...proof } });
    expect(launchChecklist(facts).find((i) => i.key === 'npn')?.evidence).toEqual([proof]);
    expect(launchChecklist(facts).find((i) => i.key === 'legalEntity')?.evidence).toEqual([]);
  });

  it('requires the NPN, appointments, full contact details and the founders’ story for launch', () => {
    const required = launchChecklist(EMPTY).filter((i) => i.requiredForLaunch).map((i) => i.key);
    expect(required).toEqual(expect.arrayContaining(['npn', 'carriers', 'contact', 'founderStory', 'teamRole', 'legalReview']));
  });
});
