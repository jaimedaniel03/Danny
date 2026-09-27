import { describe, expect, it } from 'vitest';
import { EMPTY_VALUES, normalizeUsPhone, normalizeZip, validateInquiry, type InquiryValues } from './fields';

const valid: InquiryValues = {
  ...EMPTY_VALUES,
  fullName: '  María   José O’Neil-Díaz ',
  email: 'Maria@Example.com',
  zip: '60601-1234',
  state: 'IL',
  contactMethod: 'email',
  coverageInterest: 'both',
  consent: true,
};

describe('inquiry validation', () => {
  it('accepts a complete coverage inquiry and normalizes it', () => {
    const result = validateInquiry('coverage', valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inquiry.fullName).toBe('María José O’Neil-Díaz');
    expect(result.inquiry.emailNormalized).toBe('maria@example.com');
    expect(result.inquiry.zip).toBe('60601');
    expect(result.inquiry.phoneE164).toBeNull();
    expect(result.inquiry.licensingStatus).toBeNull();
  });

  it('reports every missing field with a plain-language message', () => {
    const result = validateInquiry('coverage', EMPTY_VALUES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['consent', 'contactMethod', 'coverageInterest', 'email', 'fullName', 'state', 'zip']);
  });

  it('requires a phone number only for a call or text', () => {
    const call = validateInquiry('coverage', { ...valid, contactMethod: 'phone' });
    expect(call.ok).toBe(false);
    if (!call.ok) expect(call.errors.phone).toMatch(/phone number/);
    const text = validateInquiry('coverage', { ...valid, contactMethod: 'text', phone: '1 (312) 555-0142' });
    expect(text.ok && text.inquiry.phoneE164).toBe('+13125550142');
    const email = validateInquiry('coverage', { ...valid, contactMethod: 'email', phone: 'ignored' });
    expect(email.ok && email.inquiry.phoneE164).toBeNull();
  });

  it('never accepts consent that was not given', () => {
    const result = validateInquiry('coverage', { ...valid, consent: false });
    expect(result.ok).toBe(false);
  });

  it('requires the licensing status and the disclosure acknowledgment on team inquiries', () => {
    const result = validateInquiry('team', { ...valid, coverageInterest: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.licensingStatus).toBeDefined();
    expect(result.errors.disclosureAck).toBeDefined();
    const ok = validateInquiry('team', { ...valid, coverageInterest: '', licensingStatus: 'studying', disclosureAck: true });
    expect(ok.ok && ok.inquiry.coverageInterest).toBeNull();
  });

  it('rejects names carrying numbers such as a Social Security number', () => {
    const result = validateInquiry('coverage', { ...valid, fullName: 'Ann 123-45-6789' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.fullName).toMatch(/Social Security/);
  });

  it('rejects links and markup in names', () => {
    expect(validateInquiry('coverage', { ...valid, fullName: 'http://spam.example' }).ok).toBe(false);
    expect(validateInquiry('coverage', { ...valid, fullName: '<script>' }).ok).toBe(false);
  });

  it('enforces length limits', () => {
    expect(validateInquiry('coverage', { ...valid, fullName: 'A'.repeat(101) }).ok).toBe(false);
    expect(validateInquiry('coverage', { ...valid, email: `${'a'.repeat(250)}@example.com` }).ok).toBe(false);
  });

  it('rejects values outside the allowed options', () => {
    const result = validateInquiry('coverage', { ...valid, contactMethod: 'fax', coverageInterest: 'auto' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.contactMethod).toBeDefined();
    expect(result.errors.coverageInterest).toBeDefined();
  });
});

describe('normalizers', () => {
  it('normalizes US phone numbers and rejects invalid ones', () => {
    expect(normalizeUsPhone('312.555.0142')).toBe('+13125550142');
    expect(normalizeUsPhone('+1 312 555 0142')).toBe('+13125550142');
    expect(normalizeUsPhone('112 555 0142')).toBeNull();
    expect(normalizeUsPhone('555-0142')).toBeNull();
  });

  it('normalizes ZIP codes', () => {
    expect(normalizeZip('02134')).toBe('02134');
    expect(normalizeZip('02134-0001')).toBe('02134');
    expect(normalizeZip('00000')).toBeNull();
    expect(normalizeZip('2134')).toBeNull();
  });

  it('requires a real US state (or DC) by postal code', () => {
    expect(validateInquiry('coverage', { ...valid, state: '' })).toMatchObject({ ok: false, errors: { state: expect.stringMatching(/state/) } });
    expect(validateInquiry('coverage', { ...valid, state: 'XX' })).toMatchObject({ ok: false });
    expect(validateInquiry('coverage', { ...valid, state: 'DC' })).toMatchObject({ ok: true, inquiry: { state: 'DC' } });
  });
});
