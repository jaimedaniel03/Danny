/**
 * End-to-end wiring test.
 *
 * The unit suites prove each piece is right. This proves they are connected —
 * profile → gate → authorization → dialer → registry — because every bug this
 * catches is a seam bug, and seams are exactly what unit tests do not cover.
 *
 * Nothing here reaches the PSTN: `DANNY_DRY_RUN` resolves the dialer to a sink.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { dial, loggingCallbacks } from './dialer';
import {
  claimPendingCall,
  claimedCallCount,
  pendingCallCount,
  resetRegistry,
} from './call-registry';
import { permissiveTestProvider } from '@/compliance/dnc';
import type { TwilioConfig } from './twilio';
import type { AgencyProfile } from '@/config/agency';
import type { ConsentRecord, Contact } from '@/types';

const AT = new Date('2026-09-16T21:00:00Z'); // Wed 2pm Pacific — mid-window

const CONFIG: TwilioConfig = {
  accountSid: 'ACtest',
  authToken: 'token',
  callerId: '+15105550100',
  publicBaseUrl: 'https://danny.test',
  webhookSecret: 'secret',
  dryRun: true,
};

const PROFILE: AgencyProfile = {
  agencyId: '7f3d2c1a-9b4e-4f21-8c6d-1a2b3c4d5e6f',
  legalName: 'Ruiz Family Insurance LLC',
  displayName: 'Ruiz Insurance',
  npn: '19283746',
  postalAddress: '440 Grand Ave, Oakland, CA 94610',
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
    { stateCode: 'CA', classes: ['p_and_c'], licenseNumber: '0M12345', expiresAt: '2027-06-30' },
  ],
  lines: ['auto', 'home'],
  appointedCarriers: ['Safeco'],
  phone: { callerIdE164: '+15105550100', messagingServiceSid: null },
  email: { fromName: 'Ruiz', fromAddress: 'hi@ruizinsurance.com', replyTo: 'hi@ruizinsurance.com' },
  medicarePlanCount: null,
  disclosureVersion: 'v1-reviewed',
};

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
  dateOfBirth: null,
  isExistingPolicyholder: true,
  internalDncAt: null,
  leadSource: null,
};

const WRITTEN: ConsentRecord = {
  id: 'consent_1',
  contactId: 'contact_1',
  phoneE164: '+14155550123',
  basis: 'prior_express_written',
  disclosureText: 'I agree to receive calls including by artificial or prerecorded voice.',
  sourceUri: 'https://ruizinsurance.com/consent/abc',
  capturedAt: new Date('2026-08-01'),
  expiresAt: null,
  ipAddress: '203.0.113.9',
  userAgent: 'Mozilla/5.0',
  scopedLines: [],
  revokedAt: null,
};

function request(over: Partial<Parameters<typeof dial>[0]> = {}) {
  return {
    profile: PROFILE,
    contact: CONTACT,
    line: 'auto' as const,
    consents: [WRITTEN],
    ebr: { lastTransactionAt: new Date('2026-03-01'), lastInquiryAt: null },
    attempts: { today: 0, thisWeek: 0, last24h: 0 },
    dncProvider: permissiveTestProvider,
    voice: null,
    medicare: null,
    killSwitchEngaged: false,
    config: CONFIG,
    at: AT,
    ...over,
  };
}

beforeEach(() => {
  resetRegistry();
});

describe('the happy path connects end to end', () => {
  it('dials and registers the session', async () => {
    const result = await dial(request(), loggingCallbacks());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.dryRun).toBe(true);
    expect(result.providerSid).toContain('DRYRUN');
    expect(pendingCallCount()).toBe(1);
  });

  it('hands the media server deps carrying the authorization and the disclosure', async () => {
    const result = await dial(request(), loggingCallbacks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deps = claimPendingCall(result.callRecordId);
    expect(deps).not.toBeNull();
    if (!deps) return;

    expect(deps.agencyName).toBe('Ruiz Family Insurance LLC');
    expect(deps.producerName).toBe('Danny');
    expect(deps.authorization.phoneE164).toBe('+14155550123');
    // The disclosure travels on the authorization, so the runtime speaks it
    // before the model is ever invoked.
    expect(deps.authorization.requiredDisclosure).toContain("I'm not a human");
    expect(deps.authorization.requiredDisclosure).toContain('Ruiz Family Insurance LLC');
  });

  it('carries the profile through to the spoken disclosure, not a placeholder', async () => {
    const renamed = { ...PROFILE, legalName: 'Different Agency LLC' };
    const result = await dial(request({ profile: renamed }), loggingCallbacks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deps = claimPendingCall(result.callRecordId);
    expect(deps?.authorization.requiredDisclosure).toContain('Different Agency LLC');
  });
});

describe('the gate still governs, through the dialer', () => {
  it('refuses rather than throwing when consent is insufficient', async () => {
    const weak: ConsentRecord = { ...WRITTEN, basis: 'inbound_web_request' };
    const result = await dial(request({ consents: [weak] }), loggingCallbacks());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain('CONSENT_BASIS_INSUFFICIENT_FOR_AI');
    // Nothing registered — a refused dial must leave no session to claim.
    expect(pendingCallCount()).toBe(0);
  });

  it('refuses a state the profile is not licensed in', async () => {
    const texan: Contact = { ...CONTACT, stateCode: 'TX', timezone: 'America/Chicago' };
    const result = await dial(request({ contact: texan }), loggingCallbacks());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain('STATE_NOT_LICENSED');
  });

  it('refuses a line the profile has no license class for', async () => {
    const result = await dial(request({ line: 'life_term' }), loggingCallbacks());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain('LICENSE_CLASS_MISSING');
  });

  it('honours the kill switch', async () => {
    const result = await dial(request({ killSwitchEngaged: true }), loggingCallbacks());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.code).toBe('KILL_SWITCH_ENGAGED');
    expect(pendingCallCount()).toBe(0);
  });

  it('refuses outside local calling hours', async () => {
    // 13:00 UTC is 06:00 Pacific.
    const dawn = new Date('2026-09-16T13:00:00Z');
    const result = await dial(request({ at: dawn }), loggingCallbacks());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain('OUTSIDE_CALLING_HOURS');
  });
});

describe('the registry protects the authorization', () => {
  it('lets exactly one media stream claim a call', async () => {
    const result = await dial(request(), loggingCallbacks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(claimPendingCall(result.callRecordId)).not.toBeNull();
    // Two sessions on one leg would interleave audio, and the second would be
    // an unaudited use of a single-use authorization.
    expect(claimPendingCall(result.callRecordId)).toBeNull();
  });

  it('refuses an unknown call id', () => {
    expect(claimPendingCall('never-registered')).toBeNull();
  });

  it('stops counting a call as pending once it has been claimed', async () => {
    const result = await dial(request(), loggingCallbacks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(pendingCallCount()).toBe(1);
    expect(claimedCallCount()).toBe(0);

    claimPendingCall(result.callRecordId);

    // The entry is retained until TTL so a duplicate connection is
    // distinguishable from an unknown id — but a health check that counted it
    // as pending would report a leak on every call that connected normally.
    expect(pendingCallCount()).toBe(0);
    expect(claimedCallCount()).toBe(1);
  });
});

describe('synthesis without a voice model refuses rather than emitting silence', () => {
  it('throws on first read instead of looking like a successful empty turn', async () => {
    const result = await dial(request({ voice: null }), loggingCallbacks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deps = claimPendingCall(result.callRecordId);
    expect(deps).not.toBeNull();
    if (!deps) return;

    await expect(async () => {
      for await (const _chunk of deps.synthesis.synthesize('hello')) {
        // unreachable
      }
    }).rejects.toThrow(/No voice model configured/);
  });
});
