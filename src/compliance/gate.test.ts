/**
 * Compliance self-test.
 *
 * These are not unit tests in the ordinary sense — they are the assertion that
 * the system cannot do the illegal thing. CI fails the build if any known-bad
 * fixture produces an authorization. Treat a failure here as a production
 * incident, not a broken test.
 *
 * Run: npm run compliance:selftest
 */

import { describe, expect, it } from 'vitest';
import { evaluateGate, routeFailures, type GateInput, type LicenseGrant } from './gate';
import { permissiveTestProvider } from './dnc';
import { detectDncRequest, detectHumanRequest } from './disclosure';
import { checkCallingHours, effectiveWindow } from './calling-hours';
import type { ConsentRecord, Contact, GateFailureCode } from '@/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Wednesday 2026-09-16, 14:00 Pacific = 21:00 UTC. Mid-window everywhere. */
const NOON_PACIFIC = new Date('2026-09-16T21:00:00Z');

const CONTACT: Contact = {
  id: 'contact_1',
  phoneE164: '+14155550123',
  lineType: 'mobile',
  firstName: 'Dana',
  lastName: 'Ruiz',
  email: 'dana@example.com',
  stateCode: 'CA',
  postalCode: '94110',
  timezone: 'America/Los_Angeles',
  dateOfBirth: new Date('1985-04-02'),
  isExistingPolicyholder: true,
  internalDncAt: null,
};

const WRITTEN_CONSENT: ConsentRecord = {
  id: 'consent_1',
  contactId: 'contact_1',
  phoneE164: '+14155550123',
  basis: 'prior_express_written',
  disclosureText:
    'I agree to receive calls and texts, including by automated technology and ' +
    'artificial or prerecorded voice, from Example Insurance Agency at the number provided.',
  sourceUri: 'https://example.com/quote?sid=abc123',
  capturedAt: new Date('2026-08-01T17:00:00Z'),
  expiresAt: null,
  ipAddress: '203.0.113.44',
  userAgent: 'Mozilla/5.0',
  scopedLines: [],
  revokedAt: null,
};

const LICENSES: LicenseGrant[] = [
  { stateCode: 'CA', classes: ['p_and_c', 'life', 'health'], expiresAt: new Date('2027-12-31') },
];

function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    contact: CONTACT,
    line: 'auto',
    consents: [WRITTEN_CONSENT],
    licenses: LICENSES,
    ebr: { lastTransactionAt: new Date('2026-03-01'), lastInquiryAt: null },
    medicare: null,
    attempts: { today: 0, thisWeek: 0, last24h: 0 },
    disclosure: {
      agentDisplayName: 'Danny',
      agencyLegalName: 'Example Insurance Agency',
      agencyNpn: '1234567890',
      medicarePlanCount: null,
    },
    dncProvider: permissiveTestProvider,
    at: NOON_PACIFIC,
    killSwitchEngaged: false,
    ...overrides,
  };
}

async function codes(input: GateInput): Promise<GateFailureCode[]> {
  const result = await evaluateGate(input);
  return result.ok ? [] : result.failures.map((f) => f.code);
}

// ── The happy path exists ────────────────────────────────────────────────────

describe('gate: the one case that should pass', () => {
  it('authorizes a written-consent, licensed, in-hours, clean-scrub dial', async () => {
    const result = await evaluateGate(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.authorization.consentBasis).toBe('prior_express_written');
    expect(result.authorization.evidence).toBeTruthy();
    expect(Object.isFrozen(result.authorization.evidence)).toBe(true);
  });

  it('front-loads the AI disclosure in the required opening', async () => {
    const result = await evaluateGate(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opening = result.authorization.requiredDisclosure;
    // Identity before anything else.
    expect(opening.indexOf('AI assistant')).toBeLessThan(opening.indexOf('recorded'));
    expect(opening).toContain("I'm not a human");
    expect(opening).toContain('recorded');
  });

  it('issues a short-lived authorization', async () => {
    const result = await evaluateGate(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ttlMs = result.authorization.expiresAt.getTime() - result.authorization.issuedAt.getTime();
    expect(ttlMs).toBeLessThanOrEqual(120_000);
  });
});

// ── Consent ──────────────────────────────────────────────────────────────────

describe('gate: consent is the hard wall', () => {
  it('refuses with no consent record at all', async () => {
    expect(await codes(baseInput({ consents: [] }))).toContain('NO_CONSENT_RECORD');
  });

  it('refuses unsigned web-form consent — an AI voice needs written consent', async () => {
    const weak: ConsentRecord = { ...WRITTEN_CONSENT, basis: 'inbound_web_request' };
    expect(await codes(baseInput({ consents: [weak] }))).toContain(
      'CONSENT_BASIS_INSUFFICIENT_FOR_AI',
    );
  });

  it('refuses on established business relationship alone', async () => {
    // The trap: EBR exempts you from the DNC *registry*, not from 227(b).
    // A current policyholder is still an artificial-voice call.
    const ebrOnly: ConsentRecord = {
      ...WRITTEN_CONSENT,
      basis: 'established_business_relationship',
    };
    expect(await codes(baseInput({ consents: [ebrOnly] }))).toContain(
      'CONSENT_BASIS_INSUFFICIENT_FOR_AI',
    );
  });

  it('refuses revoked consent', async () => {
    const revoked: ConsentRecord = {
      ...WRITTEN_CONSENT,
      revokedAt: new Date('2026-09-01T00:00:00Z'),
    };
    expect(await codes(baseInput({ consents: [revoked] }))).toContain('CONSENT_REVOKED');
  });

  it('refuses expired consent', async () => {
    const expired: ConsentRecord = {
      ...WRITTEN_CONSENT,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    };
    expect(await codes(baseInput({ consents: [expired] }))).toContain('CONSENT_EXPIRED');
  });

  it('does not let auto consent authorize a life call', async () => {
    const scoped: ConsentRecord = { ...WRITTEN_CONSENT, scopedLines: ['auto'] };
    expect(await codes(baseInput({ consents: [scoped], line: 'life_term' }))).toContain(
      'CONSENT_SCOPE_MISMATCH',
    );
  });

  it('routes an insufficient-basis lead to the human queue rather than the bin', async () => {
    const weak: ConsentRecord = { ...WRITTEN_CONSENT, basis: 'prior_express' };
    const result = await evaluateGate(baseInput({ consents: [weak] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const routed = routeFailures(result.failures);
    expect(routed.dead).toHaveLength(0);
    expect(routed.humanQueue.map((f) => f.code)).toContain('CONSENT_BASIS_INSUFFICIENT_FOR_AI');
  });
});

// ── DNC ──────────────────────────────────────────────────────────────────────

describe('gate: do-not-call', () => {
  it('refuses an internal DNC contact even with written consent and an EBR', async () => {
    const listed: Contact = { ...CONTACT, internalDncAt: new Date('2026-07-04') };
    const result = await evaluateGate(baseInput({ contact: listed }));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.failures.map((f) => f.code)).toContain('INTERNAL_DNC');
    // No exemption may resurrect this one.
    expect(routeFailures(result.failures).humanQueue).toHaveLength(0);
  });

  it('refuses a federally listed number with no EBR', async () => {
    const codesOut = await codes(
      baseInput({
        ebr: { lastTransactionAt: null, lastInquiryAt: null },
        dncProvider: {
          ...permissiveTestProvider,
          async checkFederal() {
            return { list: 'federal' as const, listed: true, checkedAt: NOON_PACIFIC };
          },
        },
      }),
    );
    expect(codesOut).toContain('FEDERAL_DNC');
  });

  it('flags litigator-list numbers', async () => {
    const codesOut = await codes(
      baseInput({
        dncProvider: {
          ...permissiveTestProvider,
          async checkLitigator() {
            return { list: 'litigator' as const, listed: true, checkedAt: NOON_PACIFIC };
          },
        },
      }),
    );
    expect(codesOut).toContain('LITIGATOR_LIST');
  });
});

// ── Hours ────────────────────────────────────────────────────────────────────

describe('gate: calling hours', () => {
  it('refuses a 6am local dial', async () => {
    // 13:00 UTC = 06:00 Pacific.
    const dawn = new Date('2026-09-16T13:00:00Z');
    expect(await codes(baseInput({ at: dawn }))).toContain('OUTSIDE_CALLING_HOURS');
  });

  it('refuses a 9:30pm local dial', async () => {
    // 04:30 UTC next day = 21:30 Pacific.
    const late = new Date('2026-09-17T04:30:00Z');
    expect(await codes(baseInput({ at: late }))).toContain('OUTSIDE_CALLING_HOURS');
  });

  it('fails closed on an unknown timezone rather than guessing from area code', async () => {
    const noTz: Contact = { ...CONTACT, timezone: null };
    expect(await codes(baseInput({ contact: noTz }))).toContain('UNKNOWN_TIMEZONE');
  });

  it('applies the narrower state window where one exists', () => {
    expect(effectiveWindow('FL').endMinute).toBe(20 * 60);
    expect(effectiveWindow('CA').endMinute).toBe(21 * 60);
    expect(effectiveWindow('KY').startMinute).toBe(9 * 60);
  });

  it('honours Sunday prohibitions', () => {
    // Sunday 2026-09-20, 18:00 UTC = 11:00 Pacific — mid-window, wrong day.
    const sunday = new Date('2026-09-20T18:00:00Z');
    const check = checkCallingHours({
      at: sunday,
      timezone: 'America/Los_Angeles',
      stateCode: 'WA',
    });
    expect(check.allowed).toBe(false);
  });

  it('respects DST rather than assuming a fixed offset', () => {
    // 2026-11-05 is after the US fall-back; 04:30 UTC = 20:30 Pacific (in window).
    const check = checkCallingHours({
      at: new Date('2026-11-05T04:30:00Z'),
      timezone: 'America/Los_Angeles',
      stateCode: 'CA',
    });
    expect(check.allowed).toBe(true);
  });
});

// ── Licensing & Medicare ─────────────────────────────────────────────────────

describe('gate: licensing', () => {
  it('refuses a state where no producer license is held', async () => {
    const texan: Contact = { ...CONTACT, stateCode: 'TX', timezone: 'America/Chicago' };
    expect(await codes(baseInput({ contact: texan }))).toContain('STATE_NOT_LICENSED');
  });

  it('refuses a life call when only P&C is held', async () => {
    const pcOnly: LicenseGrant[] = [
      { stateCode: 'CA', classes: ['p_and_c'], expiresAt: new Date('2027-12-31') },
    ];
    expect(await codes(baseInput({ licenses: pcOnly, line: 'life_term' }))).toContain(
      'LICENSE_CLASS_MISSING',
    );
  });

  it('refuses an expired license', async () => {
    const stale: LicenseGrant[] = [
      { stateCode: 'CA', classes: ['p_and_c'], expiresAt: new Date('2026-01-01') },
    ];
    expect(await codes(baseInput({ licenses: stale }))).toContain('STATE_NOT_LICENSED');
  });
});

describe('gate: Medicare', () => {
  it('refuses a Medicare call with no permission to contact', async () => {
    expect(await codes(baseInput({ line: 'health_medicare', medicare: null }))).toContain(
      'MEDICARE_PTC_MISSING',
    );
  });

  it('refuses a stale permission to contact', async () => {
    const codesOut = await codes(
      baseInput({
        line: 'health_medicare',
        medicare: {
          permissionToContactAt: new Date('2025-01-01'),
          permissionScope: ['health_medicare'],
        },
      }),
    );
    expect(codesOut).toContain('MEDICARE_PTC_MISSING');
  });

  it('reads the CMS TPMO disclaimer verbatim when authorized', async () => {
    const result = await evaluateGate(
      baseInput({
        line: 'health_medicare',
        medicare: {
          permissionToContactAt: new Date('2026-06-01'),
          permissionScope: ['health_medicare'],
        },
        disclosure: {
          agentDisplayName: 'Danny',
          agencyLegalName: 'Example Insurance Agency',
          agencyNpn: '1234567890',
          medicarePlanCount: { carriers: 4, plans: 22 },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opening = result.authorization.requiredDisclosure;
    expect(opening).toContain('We do not offer every plan available in your area');
    expect(opening).toContain('1-800-MEDICARE');
    expect(opening).toContain('4 organizations which offer 22 products');
  });
});

// ── Caps and the kill switch ─────────────────────────────────────────────────

describe('gate: frequency and stop controls', () => {
  it('enforces the daily attempt cap', async () => {
    expect(
      await codes(baseInput({ attempts: { today: 2, thisWeek: 2, last24h: 2 } })),
    ).toContain('ATTEMPT_CAP_EXCEEDED');
  });

  it('enforces the Florida 3-per-24h cap', async () => {
    const floridian: Contact = { ...CONTACT, stateCode: 'FL', timezone: 'America/New_York' };
    const flLicense: LicenseGrant[] = [
      { stateCode: 'FL', classes: ['p_and_c', 'life', 'health'], expiresAt: new Date('2027-12-31') },
    ];
    // 17:00 UTC = 13:00 Eastern, inside FL's 8a-8p window.
    const codesOut = await codes(
      baseInput({
        contact: floridian,
        licenses: flLicense,
        at: new Date('2026-09-16T17:00:00Z'),
        attempts: { today: 1, thisWeek: 3, last24h: 3 },
      }),
    );
    expect(codesOut).toContain('ATTEMPT_CAP_EXCEEDED');
  });

  it('the kill switch stops everything and short-circuits', async () => {
    const result = await evaluateGate(baseInput({ killSwitchEngaged: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe('KILL_SWITCH_ENGAGED');
  });
});

// ── In-call detectors ────────────────────────────────────────────────────────

describe('in-call detectors', () => {
  it.each([
    'Take me off your list',
    "Please don't call me again",
    'STOP CALLING ME',
    'do not call, thanks',
    'yeah remove my number',
  ])('detects a DNC request in %j', (utterance) => {
    expect(detectDncRequest(utterance)).toBe(true);
  });

  it.each([
    'Sure, go ahead and call me tomorrow',
    'What does that cost?',
    'I already have coverage',
  ])('does not false-positive on %j', (utterance) => {
    expect(detectDncRequest(utterance)).toBe(false);
  });

  it.each([
    'Am I talking to a robot?',
    'Can I speak to a person',
    'put me through to a licensed agent',
    'are you a real person',
  ])('detects a human request in %j', (utterance) => {
    expect(detectHumanRequest(utterance)).toBe(true);
  });
});
