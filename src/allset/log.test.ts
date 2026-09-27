import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, log } from './log';

function captured(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  expect(spy.mock.calls).toHaveLength(1);
  return JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('log redaction', () => {
  it('withholds fields named for personal data or secrets, in any spelling', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.info('test.event', {
      email: 'a',
      email_normalized: 'b',
      emailNormalized: 'c',
      fullName: 'd',
      full_name: 'e',
      phoneE164: 'f',
      IPs: 'g',
      client_ip: 'h',
      'x-auth-token': 'i',
      sessionToken: 'j',
      password: 'k',
      notes: 'l',
      Cookie: 'm',
      authorization: 'n',
      zip: 'o',
      mailing_address: 'p',
    });
    const line = captured(spy);
    for (const key of [
      'email', 'email_normalized', 'emailNormalized', 'fullName', 'full_name', 'phoneE164', 'IPs', 'client_ip',
      'x-auth-token', 'sessionToken', 'password', 'notes', 'Cookie', 'authorization', 'zip', 'mailing_address',
    ]) {
      expect(line[key], key).toBe('[withheld]');
    }
  });

  it('withholds values shaped like an email, a phone number or a secret, whatever the key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('test.event', {
      detail: 'reply went to jane.doe@example.com',
      reason: 'call (312) 555-0142 back',
      intl: '+1 312 555 0142',
      opaque: 'dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZQ_-abc',
      digest: 'a'.repeat(64),
      // A token glued to a uuid is still a token.
      mixed: '5f0c2a8e-9b1d-4c3e-8f7a-2d6b1e0c9a4f' + 'Q'.repeat(40),
    });
    const line = captured(spy);
    expect(line.detail).toBe('[withheld]');
    expect(line.reason).toBe('[withheld]');
    expect(line.intl).toBe('[withheld]');
    expect(line.opaque).toBe('[withheld]');
    expect(line.digest).toBe('[withheld]');
    expect(line.mixed).toBe('[withheld]');
  });

  it('keeps the operational fields the app actually logs', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.info('inquiry.accepted', {
      kind: 'coverage',
      replay: false,
      merged: true,
      notification_id: '5f0c2a8e-9b1d-4c3e-8f7a-2d6b1e0c9a4f',
      lead_id: '12345678-1234-4234-8234-123456789012',
      attempts: 3,
      verdict: 'expired',
      outcome: 'updated',
      deleted: 12,
    });
    const line = captured(spy);
    expect(line).toMatchObject({
      level: 'info',
      event: 'inquiry.accepted',
      kind: 'coverage',
      replay: false,
      merged: true,
      notification_id: '5f0c2a8e-9b1d-4c3e-8f7a-2d6b1e0c9a4f',
      lead_id: '12345678-1234-4234-8234-123456789012',
      attempts: 3,
      verdict: 'expired',
      outcome: 'updated',
      deleted: 12,
    });
  });

  it('truncates long values', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.info('test.event', { kind: 'word '.repeat(100) });
    expect(String(captured(spy).kind)).toHaveLength(200);
  });
});

describe('describeError', () => {
  it('keeps the class, code and constraint, never the message or detail', () => {
    // What postgres.js throws on a unique violation: the message and detail quote the value.
    const error = Object.assign(new Error('duplicate key value violates unique constraint "leads_email_key"'), {
      name: 'PostgresError',
      code: '23505',
      constraint_name: 'leads_email_key',
      detail: 'Key (email_normalized)=(jane.doe@example.com) already exists.',
    });
    const described = describeError(error);
    expect(described).toEqual({ error_class: 'PostgresError', error_code: '23505', error_constraint: 'leads_email_key' });
    expect(JSON.stringify(described)).not.toContain('jane.doe');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('inquiry.save_failed', error, { kind: 'coverage' });
    const line = JSON.stringify(captured(spy));
    expect(line).not.toContain('jane.doe');
    expect(line).not.toContain('duplicate key');
    expect(line).toContain('"error_code":"23505"');
  });

  it('reduces non-objects to their type', () => {
    expect(describeError('someone@example.com')).toEqual({ error_class: 'string' });
    expect(describeError(undefined)).toEqual({ error_class: 'undefined' });
  });
});
