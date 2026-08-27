import { describe, expect, it } from 'vitest';
import {
  inferConsentBasis,
  normalizePhoneUS,
  normalizeState,
  parseCsv,
  stateToTimezone,
  zipToState,
} from './normalize';

describe('normalizePhoneUS', () => {
  it.each([
    ['(415) 555-0123', '+14155550123'],
    ['415-555-0123', '+14155550123'],
    ['415.555.0123', '+14155550123'],
    ['1-415-555-0123', '+14155550123'],
    ['+1 415 555 0123', '+14155550123'],
    ['4155550123', '+14155550123'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhoneUS(input)).toBe(expected);
  });

  it.each([
    ['555-0123'], // too short
    ['(415) 555-01'], // too short
    ['44 20 7946 0958'], // not NANP
    ['0155550123'], // area code can't start with 0
    ['1155550123'], // or 1
    ['4115550123'], // N11 area code
    ['4150555123'], // exchange can't start with 0
    [''],
    ['n/a'],
  ])('rejects %s', (input) => {
    expect(normalizePhoneUS(input)).toBeNull();
  });
});

describe('normalizeState', () => {
  it('accepts codes, names, and trailing periods', () => {
    expect(normalizeState('CA')).toBe('CA');
    expect(normalizeState('ca ')).toBe('CA');
    expect(normalizeState('California')).toBe('CA');
    expect(normalizeState('new york')).toBe('NY');
  });
  it('rejects junk', () => {
    expect(normalizeState('Calif')).toBeNull();
    expect(normalizeState('XX')).toBeNull();
    expect(normalizeState('')).toBeNull();
  });
});

describe('zipToState', () => {
  it.each([
    ['94110', 'CA'],
    ['10001', 'NY'],
    ['78701', 'TX'],
    ['33101', 'FL'],
    ['60601', 'IL'],
    ['2138', 'MA'], // Excel ate the leading zero
    ['02138-1901', 'MA'], // zip+4
  ])('maps %s to %s', (zip, state) => {
    expect(zipToState(zip)).toBe(state);
  });

  it('returns null on garbage rather than guessing', () => {
    expect(zipToState('ABCDE')).toBeNull();
    expect(zipToState('')).toBeNull();
  });
});

describe('stateToTimezone', () => {
  it('flags split-timezone states', () => {
    expect(stateToTimezone('TX')).toEqual({ timezone: 'America/Chicago', confidence: 'split' });
    expect(stateToTimezone('FL')?.confidence).toBe('split');
  });
  it('is confident about single-zone states', () => {
    expect(stateToTimezone('CA')).toEqual({
      timezone: 'America/Los_Angeles',
      confidence: 'single',
    });
    expect(stateToTimezone('AZ')?.timezone).toBe('America/Phoenix');
  });
});

describe('inferConsentBasis', () => {
  it('maps the aliases people actually type', () => {
    expect(inferConsentBasis('written').basis).toBe('prior_express_written');
    expect(inferConsentBasis('Inbound').basis).toBe('inbound_call');
    expect(inferConsentBasis('web form').basis).toBe('inbound_web_request');
    expect(inferConsentBasis('EBR').basis).toBe('established_business_relationship');
  });

  it('treats purchased lists and blanks as no consent', () => {
    expect(inferConsentBasis('purchased').basis).toBe('none');
    expect(inferConsentBasis('').basis).toBe('none');
  });

  it('treats a referral as no consent — the referee never agreed to anything', () => {
    expect(inferConsentBasis('referral').basis).toBe('none');
  });

  it('flags unrecognized labels instead of guessing generously', () => {
    const result = inferConsentBasis('totally consented trust me');
    expect(result.basis).toBe('none');
    expect(result.recognized).toBe(false);
  });
});

describe('parseCsv', () => {
  it('handles quotes, embedded commas, and CRLF', () => {
    const rows = parseCsv('a,"b,c",d\r\n"say ""hi""",2,3\n');
    expect(rows).toEqual([
      ['a', 'b,c', 'd'],
      ['say "hi"', '2', '3'],
    ]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
