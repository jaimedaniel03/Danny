import { beforeAll, describe, expect, it } from 'vitest';
import {
  issueConsentToken,
  verifyConsentToken,
  maskPhoneForDisplay,
  TOKEN_TTL_DAYS,
} from './tokens';
import { renderDisclosure, DisclosureNotReviewedError } from './disclosure-text';

beforeAll(() => {
  process.env['CONSENT_TOKEN_SECRET'] = 'x'.repeat(48);
});

const base = {
  contactId: 'contact_1',
  phoneE164: '+14155550123',
  agencyId: 'agency_1',
  campaignId: 'winter_crosssell',
};

describe('consent tokens', () => {
  it('round-trips a valid token', () => {
    const verdict = verifyConsentToken(issueConsentToken(base));
    expect(verdict.valid).toBe(true);
    if (!verdict.valid) return;
    expect(verdict.payload.phoneE164).toBe('+14155550123');
    expect(verdict.payload.contactId).toBe('contact_1');
    expect(verdict.payload.campaignId).toBe('winter_crosssell');
  });

  it('rejects a tampered payload — the phone number cannot be swapped', () => {
    const token = issueConsentToken(base);
    const [body, signature] = token.split('.') as [string, string];

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
    payload['phoneE164'] = '+14155559999';
    const forgedBody = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');

    const verdict = verifyConsentToken(`${forgedBody}.${signature}`);
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.reason).toBe('bad_signature');
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueConsentToken(base);
    process.env['CONSENT_TOKEN_SECRET'] = 'y'.repeat(48);
    const verdict = verifyConsentToken(token);
    process.env['CONSENT_TOKEN_SECRET'] = 'x'.repeat(48);

    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.reason).toBe('bad_signature');
  });

  it('expires after the TTL', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const token = issueConsentToken({ ...base, now: issuedAt });

    const justInside = new Date(issuedAt.getTime() + (TOKEN_TTL_DAYS * 86_400 - 60) * 1000);
    expect(verifyConsentToken(token, justInside).valid).toBe(true);

    const justOutside = new Date(issuedAt.getTime() + (TOKEN_TTL_DAYS * 86_400 + 60) * 1000);
    const verdict = verifyConsentToken(token, justOutside);
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.reason).toBe('expired');
  });

  it.each([['garbage'], [''], ['a.b.c'], ['onlyonepart']])(
    'rejects malformed token %j',
    (token) => {
      expect(verifyConsentToken(token).valid).toBe(false);
    },
  );

  it('issues distinguishable tokens for the same contact', () => {
    expect(issueConsentToken(base)).not.toBe(issueConsentToken(base));
  });

  it('refuses to sign with a weak secret', () => {
    const saved = process.env['CONSENT_TOKEN_SECRET'];
    process.env['CONSENT_TOKEN_SECRET'] = 'short';
    expect(() => issueConsentToken(base)).toThrow(/at least 32 characters/);
    process.env['CONSENT_TOKEN_SECRET'] = saved;
  });
});

describe('phone masking', () => {
  it('shows enough to recognize, not enough to harvest', () => {
    expect(maskPhoneForDisplay('+14155550123')).toBe('(415) •••-0123');
    expect(maskPhoneForDisplay('4155550123')).toBe('(415) •••-0123');
  });
  it('passes through anything it cannot parse', () => {
    expect(maskPhoneForDisplay('+442079460958')).toBe('+442079460958');
  });
});

describe('disclosure rendering', () => {
  it('refuses to render unreviewed language outside development', () => {
    expect(() =>
      renderDisclosure({
        agencyLegalName: 'Example Agency',
        phoneDisplay: '(415) •••-0123',
        allowDraft: false,
      }),
    ).toThrow(DisclosureNotReviewedError);
  });

  it('resolves the seller name and number into the stored verbatim text', () => {
    const rendered = renderDisclosure({
      agencyLegalName: 'Example Insurance Agency',
      phoneDisplay: '(415) •••-0123',
      allowDraft: true,
    });

    // The seller must be named — consent to "our partners" is not consent to us.
    expect(rendered.verbatim).toContain('Example Insurance Agency');
    expect(rendered.verbatim).toContain('(415) •••-0123');
    // No unresolved template markers may reach the consumer or the ledger.
    expect(rendered.verbatim).not.toContain('{{');
  });

  it('includes the elements the FCC requires of written consent', () => {
    const { verbatim } = renderDisclosure({
      agencyLegalName: 'Example Insurance Agency',
      phoneDisplay: '(415) •••-0123',
      allowDraft: true,
    });

    // Authorizes automated technology / artificial voice.
    expect(verbatim).toMatch(/automat(ed|ic)/i);
    expect(verbatim).toMatch(/artificial|prerecorded/i);
    // The clause people forget, whose absence alone can void consent.
    expect(verbatim).toMatch(/not a condition of purchas/i);
    // Revocation must be explained.
    expect(verbatim).toMatch(/revoke/i);
  });
});
