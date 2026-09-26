import { describe, expect, it } from 'vitest';
import { hmacHex } from '@/allset/crypto';
import { checkFormToken, issueFormToken, wordingVersion } from './form-token';

const T0 = 1_790_000_000_000;

describe('form tokens', () => {
  it('accepts a token submitted a human interval after render', () => {
    expect(checkFormToken('coverage', issueFormToken('coverage', T0), T0 + 30_000)).toBe('ok');
    expect(checkFormToken('team', issueFormToken('team', T0), T0 + 30_000)).toBe('ok');
  });

  it('flags submissions that are too fast, too old, or from the future', () => {
    const token = issueFormToken('coverage', T0);
    expect(checkFormToken('coverage', token, T0 + 500)).toBe('too_fast');
    expect(checkFormToken('coverage', token, T0 + 25 * 60 * 60 * 1000)).toBe('expired');
    expect(checkFormToken('coverage', token, T0 - 1)).toBe('invalid');
  });

  it('rejects a token for the other form, or one that was edited', () => {
    const token = issueFormToken('coverage', T0);
    expect(checkFormToken('team', token, T0 + 30_000)).toBe('invalid');
    expect(checkFormToken('coverage', token.replace(/^\d/, '9'), T0 + 30_000)).toBe('invalid');
    expect(checkFormToken('coverage', 'nonsense', T0 + 30_000)).toBe('invalid');
  });

  it('refuses consent recorded against wording the person never saw', () => {
    // A validly signed token that carries an older wording version.
    const body = `${T0}.coverage-v1-0000000000`;
    const stale = `${body}.${hmacHex('form:coverage', body)}`;
    expect(wordingVersion('coverage')).not.toBe('coverage-v1-0000000000');
    expect(checkFormToken('coverage', stale, T0 + 30_000)).toBe('wording_changed');
  });

  it('ties a team form to both the consent and the acknowledgment wording', () => {
    expect(wordingVersion('team')).toMatch(/^team-v1-[0-9a-f]{10}\+team-ack-v1-[0-9a-f]{10}$/);
  });
});
