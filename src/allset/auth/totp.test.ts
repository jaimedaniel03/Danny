import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, currentStep, matchTotp, newTotpSecret, otpauthUri, totpAt } from './totp';

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890", truncated to 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(totpAt(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpAt(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('round-trips base32 and makes 160-bit secrets', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Decode('mfrg gzdf')).toEqual(base32Decode('MFRGGZDF'));
  });

  it('accepts the neighbouring step for clock drift, and nothing further', () => {
    const now = Date.parse('2026-09-26T12:00:10Z');
    const step = currentStep(now);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step), { nowMs: now })).toBe(step);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), { nowMs: now })).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), { nowMs: now })).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), { nowMs: now })).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', { nowMs: now })).toBeNull();
  });

  it('refuses a code from a step already used', () => {
    const now = Date.parse('2026-09-26T12:00:10Z');
    const step = currentStep(now);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step), { nowMs: now, lastStep: step })).toBeNull();
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step), { nowMs: now, lastStep: step - 1 })).toBe(step);
  });

  it('builds a standard otpauth link', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'sam@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/All%20Set%20Check%3Asam%40example\.com\?/);
    expect(new URL(uri.replace('otpauth://', 'https://')).searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
  });
});
