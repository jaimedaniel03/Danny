/**
 * Channel gate self-test.
 *
 * The assertion these encode: the three channels have three different consent
 * bars, and the system cannot confuse them. The most important case in the file
 * is `sms/marketing` failing where `email/marketing` passes on the same
 * contact — that gap is the entire strategy.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateChannelGate, evaluateReachability, CHANNEL_CAPS } from './gate';
import { analyzeSegments, classifyInboundSms, normalizeForGsm7 } from './sms';
import { validateEmail, issueUnsubscribeToken, verifyUnsubscribeToken, type EmailConfig } from './email';
import { CONSENT_LADDER, CONSENTED_LADDER, planOutreach, selectLadder, isUnreachable } from './orchestrator';
import { permissiveTestProvider } from '@/compliance/dnc';
import type { LicenseGrant } from '@/compliance/gate';
import type { ChannelGateInput } from './gate';
import type { ConsentRecord, Contact } from '@/types';
import type { ChannelSuppression } from './types';

beforeAll(() => {
  process.env['CONSENT_TOKEN_SECRET'] = 'z'.repeat(48);
});

const AT = new Date('2026-09-16T21:00:00Z'); // Wed 2pm Pacific

const CONTACT: Contact = {
  id: 'c1',
  phoneE164: '+14155550123',
  lineType: 'mobile',
  firstName: 'Dana',
  lastName: 'Ruiz',
  email: 'dana@example.com',
  stateCode: 'CA',
  postalCode: '94110',
  timezone: 'America/Los_Angeles',
  dateOfBirth: null,
  isExistingPolicyholder: false,
  internalDncAt: null,
  leadSource: null,
};

const LICENSES: LicenseGrant[] = [
  { stateCode: 'CA', classes: ['p_and_c', 'life', 'health'], expiresAt: new Date('2027-12-31') },
];

function consent(basis: ConsentRecord['basis']): ConsentRecord {
  return {
    id: `k_${basis}`,
    contactId: 'c1',
    phoneE164: '+14155550123',
    basis,
    disclosureText: null,
    sourceUri: null,
    capturedAt: new Date('2026-08-01'),
    expiresAt: null,
    ipAddress: null,
    userAgent: null,
    scopedLines: [],
    revokedAt: null,
  };
}

function input(over: Partial<ChannelGateInput> = {}): ChannelGateInput {
  return {
    channel: 'email',
    intent: 'marketing',
    line: 'auto',
    contact: CONTACT,
    emailAddress: 'dana@example.com',
    consents: [],
    licenses: LICENSES,
    suppressions: [],
    ebr: { lastTransactionAt: null, lastInquiryAt: null },
    attempts: { today: 0, thisWeek: 0, last24h: 0 },
    dncProvider: permissiveTestProvider,
    disclosure: {
      agencyLegalName: 'Example Insurance Agency',
      agencyPostalAddress: '1 Market St, San Francisco, CA 94105',
      agentDisplayName: 'Danny',
      agencyNpn: '1234567890',
      medicarePlanCount: null,
    },
    unsubscribeUrl: 'https://example.com/api/unsubscribe?t=abc',
    at: AT,
    killSwitchEngaged: false,
    ...over,
  };
}

// ── The gap that defines the strategy ────────────────────────────────────────

describe('the three channels have three different bars', () => {
  it('emails a contact with NO consent at all', async () => {
    const result = await evaluateChannelGate(input({ channel: 'email', consents: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.consentBasis).toBeNull();
  });

  it('refuses a promotional TEXT to that same contact', async () => {
    const result = await evaluateChannelGate(input({ channel: 'sms', consents: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.detail).toMatch(/written consent/i);
  });

  it('refuses an AI CALL to that same contact', async () => {
    const result = await evaluateChannelGate(input({ channel: 'ai_voice', consents: [] }));
    expect(result.ok).toBe(false);
  });

  it('opens SMS and AI voice once written consent exists', async () => {
    const consents = [consent('prior_express_written')];
    for (const channel of ['sms', 'ai_voice'] as const) {
      const result = await evaluateChannelGate(input({ channel, consents }));
      expect(result.ok, `${channel} should be open`).toBe(true);
    }
  });

  it('allows a transactional text on unwritten consent, but not a promotional one', async () => {
    const consents = [consent('inbound_web_request')];
    const transactional = await evaluateChannelGate(
      input({ channel: 'sms', intent: 'transactional', consents }),
    );
    const marketing = await evaluateChannelGate(
      input({ channel: 'sms', intent: 'marketing', consents }),
    );

    expect(transactional.ok).toBe(true);
    expect(marketing.ok).toBe(false);
  });
});

// ── Suppression ──────────────────────────────────────────────────────────────

describe('suppression', () => {
  const suppressed = (channel: ChannelSuppression['channel']): ChannelSuppression[] => [
    { channel, suppressedAt: new Date('2026-09-01'), reason: 'STOP', source: 'sms_stop' },
  ];

  it('blocks the suppressed channel', async () => {
    const result = await evaluateChannelGate(
      input({ channel: 'sms', consents: [consent('prior_express_written')], suppressions: suppressed('sms') }),
    );
    expect(result.ok).toBe(false);
  });

  it('does not let an SMS opt-out silently close email', async () => {
    const result = await evaluateChannelGate(
      input({ channel: 'email', suppressions: suppressed('sms') }),
    );
    expect(result.ok).toBe(true);
  });

  it('an email unsubscribe does not close the phone channels', async () => {
    const result = await evaluateChannelGate(
      input({ channel: 'ai_voice', consents: [consent('prior_express_written')], suppressions: suppressed('email') }),
    );
    expect(result.ok).toBe(true);
  });
});

// ── Channel-specific checks ──────────────────────────────────────────────────

describe('checks that apply per channel', () => {
  it('applies calling hours to SMS but not to email', async () => {
    const dawn = new Date('2026-09-16T13:00:00Z'); // 6am Pacific

    const sms = await evaluateChannelGate(
      input({ channel: 'sms', consents: [consent('prior_express_written')], at: dawn }),
    );
    const email = await evaluateChannelGate(input({ channel: 'email', at: dawn }));

    expect(sms.ok).toBe(false);
    // There is no quiet hour for an inbox.
    expect(email.ok).toBe(true);
  });

  it('applies licensing to every channel, email included', async () => {
    const texan: Contact = { ...CONTACT, stateCode: 'TX', timezone: 'America/Chicago' };
    const result = await evaluateChannelGate(input({ channel: 'email', contact: texan }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain('STATE_NOT_LICENSED');
  });

  it('enforces the tighter SMS frequency cap', async () => {
    expect(CHANNEL_CAPS.sms.perDay).toBeLessThan(CHANNEL_CAPS.ai_voice.perDay);

    const result = await evaluateChannelGate(
      input({
        channel: 'sms',
        consents: [consent('prior_express_written')],
        attempts: { today: 1, thisWeek: 1, last24h: 1 },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed email address', async () => {
    const result = await evaluateChannelGate(input({ channel: 'email', emailAddress: 'not-an-address' }));
    expect(result.ok).toBe(false);
  });
});

// ── Required footers ─────────────────────────────────────────────────────────

describe('mandatory footers', () => {
  it('puts STOP language on every text', async () => {
    const result = await evaluateChannelGate(
      input({ channel: 'sms', consents: [consent('prior_express_written')] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.requiredFooter).toContain('STOP');
    expect(result.authorization.requiredFooter).toContain('HELP');
  });

  it('puts the postal address and an unsubscribe link on every email', async () => {
    const result = await evaluateChannelGate(input({ channel: 'email' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.requiredFooter).toContain('1 Market St');
    expect(result.authorization.requiredFooter).toMatch(/unsubscribe/i);
  });
});

// ── Reachability ─────────────────────────────────────────────────────────────

describe('reachability', () => {
  it('reports email-only for a no-consent lead, and names email as the consent path', async () => {
    const r = await evaluateReachability(input({ consents: [] }));

    expect(r.channels.email.allowed).toBe(true);
    expect(r.channels.sms.allowed).toBe(false);
    expect(r.channels.ai_voice.allowed).toBe(false);
    expect(r.channels.human_voice.allowed).toBe(true);
    expect(r.bestConsentPath).toBe('email');
  });

  it('opens every channel once written consent exists', async () => {
    const r = await evaluateReachability(input({ consents: [consent('prior_express_written')] }));
    for (const channel of ['email', 'sms', 'ai_voice', 'human_voice'] as const) {
      expect(r.channels[channel].allowed, channel).toBe(true);
    }
  });
});

// ── SMS mechanics ────────────────────────────────────────────────────────────

describe('SMS segmentation', () => {
  it('counts a plain ASCII message as one GSM-7 segment', () => {
    const info = analyzeSegments('Hi Dana, quick question about your auto policy.');
    expect(info.encoding).toBe('GSM-7');
    expect(info.segments).toBe(1);
  });

  it('catches the curly apostrophe that doubles your bill', () => {
    const info = analyzeSegments('Hi Dana, here’s your quote.');
    expect(info.encoding).toBe('UCS-2');
    expect(info.offendingCharacters).toContain('’');
  });

  it('normalizes typographic characters back to GSM-7', () => {
    const normalized = normalizeForGsm7('Here’s your quote — it‘s ready…');
    expect(analyzeSegments(normalized).encoding).toBe('GSM-7');
  });

  it('splits a long message at 153 characters, not 160', () => {
    expect(analyzeSegments('a'.repeat(160)).segments).toBe(1);
    expect(analyzeSegments('a'.repeat(161)).segments).toBe(2);
    expect(analyzeSegments('a'.repeat(306)).segments).toBe(2);
    expect(analyzeSegments('a'.repeat(307)).segments).toBe(3);
  });
});

describe('inbound SMS classification', () => {
  it.each(['STOP', 'stop', 'Unsubscribe', 'CANCEL', 'quit', 'STOPALL'])(
    'treats %j as an opt-out',
    (body) => {
      expect(classifyInboundSms(body).kind).toBe('stop');
    },
  );

  it('does not treat "Stop by the office tomorrow" as an opt-out', () => {
    // Matching anywhere in the body instead of the first word loses a customer.
    expect(classifyInboundSms('Stop by the office tomorrow').kind).toBe('conversation');
  });

  it('answers HELP and START', () => {
    expect(classifyInboundSms('HELP').kind).toBe('help');
    expect(classifyInboundSms('start').kind).toBe('start');
  });

  it('passes a real reply through as conversation', () => {
    const action = classifyInboundSms('Yeah I pay about 180 a month right now');
    expect(action.kind).toBe('conversation');
  });
});

// ── Email mechanics ──────────────────────────────────────────────────────────

describe('CAN-SPAM validation', () => {
  const config: EmailConfig = {
    fromName: 'Example Insurance Agency',
    fromAddress: 'hello@example.com',
    replyToAddress: 'hello@example.com',
    postalAddress: '1 Market St, San Francisco, CA 94105',
    apiKey: null,
    dryRun: true,
  };

  const ok = { config, bodyText: 'Hello.', footer: 'Unsubscribe: https://x/u' };

  it('accepts a compliant message', () => {
    expect(validateEmail({ ...ok, subject: 'Your auto quote' }).ok).toBe(true);
  });

  it('rejects a missing postal address', () => {
    const result = validateEmail({ ...ok, config: { ...config, postalAddress: '' }, subject: 'Hi' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/postal address/i);
  });

  it('rejects a footer with no opt-out', () => {
    expect(validateEmail({ ...ok, footer: 'Thanks!', subject: 'Hi' }).ok).toBe(false);
  });

  it.each([
    'Re: your policy',
    'FWD: quote',
    'URGENT: action required',
    'Your coverage has been cancelled',
    'Medicare enrollment notice',
  ])('rejects deceptive subject %j', (subject) => {
    expect(validateEmail({ ...ok, subject }).ok).toBe(false);
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips', () => {
    const token = issueUnsubscribeToken({ contactId: 'c1', emailAddress: 'Dana@Example.com' });
    const verdict = verifyUnsubscribeToken(token);
    expect(verdict.valid).toBe(true);
    if (!verdict.valid) return;
    // Lowercased on issue, so a case difference cannot produce two records.
    expect(verdict.emailAddress).toBe('dana@example.com');
  });

  it('rejects a forged token — you cannot walk the list', () => {
    const token = issueUnsubscribeToken({ contactId: 'c1', emailAddress: 'dana@example.com' });
    const [body] = token.split('.') as [string, string];
    expect(verifyUnsubscribeToken(`${body}.forged`).valid).toBe(false);
  });

  it('does not expire — CAN-SPAM requires it to keep working', () => {
    const token = issueUnsubscribeToken({ contactId: 'c1', emailAddress: 'dana@example.com' });
    expect(verifyUnsubscribeToken(token).valid).toBe(true);
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────

describe('outreach ladders', () => {
  it('leads with email when there is no written consent', () => {
    expect(CONSENT_LADDER[0]?.channel).toBe('email');
    expect(selectLadder({ hasWrittenConsent: false, isInboundLead: false })[0]?.channel).toBe('email');
  });

  it('leads with the AI call once consent exists', () => {
    expect(CONSENTED_LADDER[0]?.channel).toBe('ai_voice');
    expect(selectLadder({ hasWrittenConsent: true, isInboundLead: false })[0]?.channel).toBe('ai_voice');
  });

  it('never puts a promotional SMS in the unconsented ladder', () => {
    const promotionalSms = CONSENT_LADDER.filter(
      (s) => s.channel === 'sms' && s.intent === 'marketing',
    );
    expect(promotionalSms).toHaveLength(0);
  });

  it('keeps blocked steps visible in the plan rather than dropping them', async () => {
    const reachability = await evaluateReachability(input({ consents: [] }));
    const plan = planOutreach({ reachability, ladder: CONSENTED_LADDER, startAt: AT });

    expect(plan).toHaveLength(CONSENTED_LADDER.length);
    const aiStep = plan.find((s) => s.channel === 'ai_voice');
    expect(aiStep?.viable).toBe(false);
    expect(aiStep?.blockedReason).toBeTruthy();
  });

  it('flags a fully unreachable contact', async () => {
    const reachability = await evaluateReachability(
      input({
        consents: [],
        suppressions: [
          { channel: 'email', suppressedAt: AT, reason: 'x', source: 'email_unsubscribe' },
          { channel: 'sms', suppressedAt: AT, reason: 'x', source: 'sms_stop' },
          { channel: 'ai_voice', suppressedAt: AT, reason: 'x', source: 'verbal' },
          { channel: 'human_voice', suppressedAt: AT, reason: 'x', source: 'verbal' },
        ],
      }),
    );
    const plan = planOutreach({ reachability, ladder: CONSENT_LADDER, startAt: AT });
    expect(isUnreachable(plan)).toBe(true);
  });

  it('schedules steps at the stated offsets', () => {
    const plan = planOutreach({
      reachability: {
        contactId: 'c1',
        channels: {
          email: { allowed: true, reason: '' },
          sms: { allowed: true, reason: '' },
          ai_voice: { allowed: true, reason: '' },
          human_voice: { allowed: true, reason: '' },
        },
        bestConsentPath: 'email',
      },
      ladder: CONSENT_LADDER,
      startAt: AT,
    });

    expect(plan[0]?.scheduledFor.getTime()).toBe(AT.getTime());
    expect(plan[1]?.scheduledFor.getTime()).toBe(AT.getTime() + 24 * 3_600_000);
  });
});
