/**
 * The production dial callbacks.
 *
 * `loggingCallbacks` was the only implementation for a while, which meant a real
 * call's disposition went to stdout and nowhere else — and, worse, a do-not-call
 * request honoured out loud on the call was never written to the suppression
 * ledger, so the next campaign would dial them again. These prove the writes
 * happen, and that a failed write is loud rather than silent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persistingCallbacks } from './dialer';
import type { CallOutcome } from './media-server';

const recordCallOutcomeById = vi.fn();
const suppressNumber = vi.fn();

vi.mock('@/db/calls', () => ({
  recordCallOutcomeById: (...args: unknown[]) => recordCallOutcomeById(...args) as unknown,
}));

vi.mock('@/db/consents', () => ({
  suppressNumber: (...args: unknown[]) => suppressNumber(...args) as unknown,
}));

const OUTCOME: CallOutcome = {
  disposition: 'appointment_set',
  finalState: 'CLOSING_OUT',
  transcript: [],
  aiDisclosedAt: new Date('2026-09-14T19:00:00Z'),
  durationMs: 94_400,
};

const INPUT = { callRecordId: 'call_1', contactId: 'contact_1' };

beforeEach(() => {
  recordCallOutcomeById.mockReset().mockResolvedValue(undefined);
  suppressNumber.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('the outcome is written', () => {
  it('records the disposition against the call record', async () => {
    await persistingCallbacks(INPUT).onComplete(OUTCOME);

    expect(recordCallOutcomeById).toHaveBeenCalledWith({
      callRecordId: 'call_1',
      disposition: 'appointment_set',
      finalState: 'CLOSING_OUT',
      durationSeconds: 94,
      aiDisclosedAt: OUTCOME.aiDisclosedAt,
    });
  });

  it('carries a null disclosure timestamp through rather than inventing one', async () => {
    await persistingCallbacks(INPUT).onComplete({ ...OUTCOME, aiDisclosedAt: null });

    expect(recordCallOutcomeById.mock.calls[0]?.[0]).toMatchObject({ aiDisclosedAt: null });
  });

  it('logs rather than throws when the write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    recordCallOutcomeById.mockRejectedValue(new Error('connection reset'));

    // The call is already over. Throwing cannot un-place it, and an exception
    // escaping the media server's `finish()` would take the socket with it.
    await expect(persistingCallbacks(INPUT).onComplete(OUTCOME)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe('a do-not-call request reaches the suppression ledger', () => {
  it('suppresses the number, naming the call it came from', async () => {
    await persistingCallbacks(INPUT).onDncRequested('+14155550123');

    expect(suppressNumber).toHaveBeenCalledWith({
      phoneE164: '+14155550123',
      reason: 'Requested on call call_1',
    });
  });

  it('shouts when the suppression write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    suppressNumber.mockRejectedValue(new Error('connection reset'));

    await expect(
      persistingCallbacks(INPUT).onDncRequested('+14155550123'),
    ).resolves.toBeUndefined();

    // The prospect was told they were removed and they were not. That is the
    // one log line in this file someone has to act on by hand.
    const message = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('+14155550123');
    expect(message).toContain('NOT suppressed');
  });
});
