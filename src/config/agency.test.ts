/**
 * Agency profile validation.
 *
 * These are compliance tests wearing config-validation clothes. The
 * `licensedStates` field fails in two opposite directions — too narrow blocks
 * lawful work, too wide permits an unlicensed solicitation — and only one of
 * those shows up as a bug report. So the validator is strict and these assert it.
 */

import { describe, expect, it } from 'vitest';
import { validateProfile, licenseGrants, primaryProducer, voiceSubject, type AgencyProfile } from './agency';

const NOW = new Date('2026-09-01T00:00:00Z');

const VALID: AgencyProfile = {
  legalName: 'Ruiz Family Insurance LLC',
  displayName: 'Ruiz Insurance',
  npn: '19283746',
  postalAddress: '440 Grand Ave Suite 200, Oakland, CA 94610',
  agentDisplayName: 'Danny',
  producers: [
    {
      legalName: 'Daniel Ruiz',
      displayName: 'Danny',
      npn: '19283746',
      email: 'danny@ruizinsurance.com',
      transferPhoneE164: '+15105550111',
      isVoiceSubject: true,
    },
  ],
  licenses: [
    {
      stateCode: 'CA',
      classes: ['p_and_c'],
      licenseNumber: '0M12345',
      expiresAt: '2027-06-30',
    },
  ],
  lines: ['auto', 'home'],
  appointedCarriers: ['Safeco', 'Travelers'],
  phone: { callerIdE164: '+15105550100', messagingServiceSid: 'MG0000' },
  email: {
    fromName: 'Ruiz Insurance',
    fromAddress: 'hello@ruizinsurance.com',
    replyTo: 'hello@ruizinsurance.com',
  },
  medicarePlanCount: null,
  disclosureVersion: 'v1-reviewed',
};

const blockers = (p: AgencyProfile): string[] =>
  validateProfile(p, NOW)
    .filter((x) => x.severity === 'blocking')
    .map((x) => x.field);

describe('a complete profile passes', () => {
  it('has no blocking problems', () => {
    expect(blockers(VALID)).toEqual([]);
  });
});

describe('placeholders are caught', () => {
  it.each(['Example Insurance Agency', 'Your Agency', 'Acme Insurance', 'Test Agency'])(
    'rejects %j as the legal name',
    (legalName) => {
      // Consent naming a fictional seller is not consent to you.
      expect(blockers({ ...VALID, legalName })).toContain('legalName');
    },
  );
});

describe('licensing', () => {
  it('refuses a profile with no licenses at all', () => {
    expect(blockers({ ...VALID, licenses: [] })).toContain('licenses');
  });

  it('refuses an expired license rather than dialling into that state', () => {
    const stale = { ...VALID, licenses: [{ ...VALID.licenses[0]!, expiresAt: '2026-01-01' }] };
    expect(blockers(stale)).toContain('licenses');
  });

  it('warns before a license lapses, while it still works', () => {
    const soon = { ...VALID, licenses: [{ ...VALID.licenses[0]!, expiresAt: '2026-10-01' }] };
    const problems = validateProfile(soon, NOW);
    expect(problems.some((p) => p.severity === 'warning' && p.field === 'licenses')).toBe(true);
    expect(blockers(soon)).toEqual([]);
  });

  it('rejects a non-USPS state code', () => {
    const bad = { ...VALID, licenses: [{ ...VALID.licenses[0]!, stateCode: 'XX' }] };
    expect(blockers(bad)).toContain('licenses');
  });

  it('refuses a line the license class does not cover', () => {
    // P&C only, but selling term life. The gate would block every life call;
    // better to catch it at config time than to wonder why nothing dials.
    expect(blockers({ ...VALID, lines: ['auto', 'life_term'] })).toContain('lines');
  });

  it('accepts a line once the matching class is licensed', () => {
    const withLife = {
      ...VALID,
      lines: ['auto', 'life_term'] as const,
      licenses: [{ ...VALID.licenses[0]!, classes: ['p_and_c', 'life'] as const }],
    };
    expect(blockers(withLife)).toEqual([]);
  });

  it('expands life_and_health into both classes for the gate', () => {
    const combined = {
      ...VALID,
      licenses: [{ ...VALID.licenses[0]!, classes: ['life_and_health'] as const }],
      lines: ['life_term'] as const,
    };
    const grants = licenseGrants(combined);
    expect(grants[0]?.classes).toContain('life');
    expect(grants[0]?.classes).toContain('health');
  });
});

describe('Medicare carries extra requirements', () => {
  const medicare: AgencyProfile = {
    ...VALID,
    lines: ['health_medicare'],
    licenses: [{ ...VALID.licenses[0]!, classes: ['health'] }],
  };

  it('requires the agency NPN for the CMS disclaimer', () => {
    expect(blockers({ ...medicare, npn: null })).toContain('npn');
  });

  it('requires a truthful plan count', () => {
    expect(blockers({ ...medicare, medicarePlanCount: null })).toContain('medicarePlanCount');
  });

  it('passes with both', () => {
    expect(blockers({ ...medicare, medicarePlanCount: { carriers: 4, plans: 22 } })).toEqual([]);
  });

  it('does not impose Medicare rules on a P&C-only agency', () => {
    expect(blockers({ ...VALID, npn: null, medicarePlanCount: null })).toEqual([]);
  });
});

describe('producers', () => {
  it('requires at least one — the AI qualifies, a human closes', () => {
    expect(blockers({ ...VALID, producers: [] })).toContain('producers');
  });

  it('requires someone to transfer to, because the disclosure promises it', () => {
    const noTransfer = {
      ...VALID,
      producers: [{ ...VALID.producers[0]!, transferPhoneE164: null }],
    };
    expect(blockers(noTransfer)).toContain('producers');
  });

  it('refuses two voice subjects', () => {
    const two = {
      ...VALID,
      producers: [
        VALID.producers[0]!,
        { ...VALID.producers[0]!, legalName: 'Sam Ruiz', displayName: 'Sam', isVoiceSubject: true },
      ],
    };
    expect(blockers(two)).toContain('producers');
  });

  it('rejects a non-E.164 transfer number', () => {
    const bad = {
      ...VALID,
      producers: [{ ...VALID.producers[0]!, transferPhoneE164: '(510) 555-0111' }],
    };
    expect(blockers(bad)).toContain('producers');
  });

  it('resolves the transfer target and the voice subject', () => {
    expect(primaryProducer(VALID).displayName).toBe('Danny');
    expect(voiceSubject(VALID)?.legalName).toBe('Daniel Ruiz');
  });
});

describe('channels', () => {
  it('requires an E.164 caller ID', () => {
    expect(blockers({ ...VALID, phone: { ...VALID.phone, callerIdE164: '510-555-0100' } }))
      .toContain('phone.callerIdE164');
  });

  it('warns but does not block when 10DLC is unregistered', () => {
    const noSms = { ...VALID, phone: { ...VALID.phone, messagingServiceSid: null } };
    // Voice and email must keep working while 10DLC registration is pending.
    expect(blockers(noSms)).toEqual([]);
    expect(validateProfile(noSms, NOW).some((p) => p.field === 'phone.messagingServiceSid')).toBe(true);
  });

  it('warns about sending from a consumer mailbox', () => {
    const gmail = {
      ...VALID,
      email: { ...VALID.email, fromAddress: 'danny@gmail.com' },
    };
    const problems = validateProfile(gmail, NOW);
    expect(problems.some((p) => p.severity === 'warning' && p.field === 'email.fromAddress')).toBe(true);
  });

  it('requires a postal address for CAN-SPAM', () => {
    expect(blockers({ ...VALID, postalAddress: '' })).toContain('postalAddress');
  });
});

describe('disclosure review', () => {
  it('warns while the consent language is still a draft', () => {
    const draft = { ...VALID, disclosureVersion: 'draft-v1' };
    const problems = validateProfile(draft, NOW);
    expect(problems.some((p) => p.field === 'disclosureVersion')).toBe(true);
    // A warning, not a blocker — you need to be able to develop against it.
    expect(blockers(draft)).toEqual([]);
  });
});
