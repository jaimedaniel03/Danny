/**
 * The Twilio webhook routes.
 *
 * These are the production entry points — the surface Twilio actually reaches —
 * and they had no tests at all. What matters here is not the happy path but the
 * refusals and the recording:
 *
 *   - An unsigned request must get a 403 from every route, with no side effect.
 *     A webhook anyone can forge is a dialer anyone can drive.
 *   - A status callback must never 5xx. Twilio retries any non-2xx, the event
 *     has already happened, and a retry cannot change it — so a throw here buys
 *     a retry storm and nothing else.
 *   - A machine-answered call must be recorded as one. Nothing else records it:
 *     no media stream opens, so the session's `onComplete` never runs, and the
 *     status callback leaves `completed` dispositions alone so it cannot
 *     overwrite a real conversation's outcome.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

const AUTH_TOKEN = 'test-auth-token';
const SECRET = 's3cret';
const BASE = 'https://danny.test';

const hangUpCall = vi.fn();
const recordCallOutcomeById = vi.fn();
const recordCallStatus = vi.fn();
const recordMessageStatus = vi.fn();
const suppressChannels = vi.fn();
const recordInboundMessage = vi.fn();

vi.mock('@/db/calls', () => ({
  recordCallOutcomeById: (...a: unknown[]) => recordCallOutcomeById(...a) as unknown,
  recordCallStatus: (...a: unknown[]) => recordCallStatus(...a) as unknown,
  recordCallRecording: vi.fn(),
}));

vi.mock('@/db/messages', () => ({
  recordMessageStatus: (...a: unknown[]) => recordMessageStatus(...a) as unknown,
  recordInboundMessage: (...a: unknown[]) => recordInboundMessage(...a) as unknown,
}));

vi.mock('@/db/suppressions', () => ({
  suppressChannels: (...a: unknown[]) => suppressChannels(...a) as unknown,
  unsuppressChannel: vi.fn(),
}));

/**
 * Build a request Twilio would have signed.
 *
 * Signing it for real, rather than stubbing the validator, is the point: it
 * proves the routes verify against the same algorithm Twilio uses, including
 * the URL-with-query-string detail that is easy to get wrong.
 */
function signedRequest(path: string, params: Record<string, string>): NextRequest {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}s=${SECRET}`;

  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signatureFor(url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** Twilio's scheme: HMAC-SHA1 over the full URL plus the params in key order. */
function signatureFor(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function unsignedRequest(path: string, params: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${BASE}${path}?s=${SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

beforeEach(() => {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest');
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
  vi.stubEnv('TWILIO_CALLER_ID', '+15105550100');
  vi.stubEnv('PUBLIC_BASE_URL', BASE);
  vi.stubEnv('TWILIO_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('DANNY_DRY_RUN', 'true');

  for (const fn of [
    hangUpCall,
    recordCallOutcomeById,
    recordCallStatus,
    recordMessageStatus,
    suppressChannels,
    recordInboundMessage,
  ]) {
    fn.mockReset().mockResolvedValue(undefined);
  }

  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('every route refuses an unsigned request', () => {
  it.each([
    ['voice', () => import('./voice/route')],
    ['status', () => import('./status/route')],
    ['amd', () => import('./amd/route')],
    ['recording', () => import('./recording/route')],
    ['sms-status', () => import('./sms-status/route')],
    ['sms-inbound', () => import('./sms-inbound/route')],
  ])('%s returns 403', async (name, load) => {
    const { POST } = await load();
    const response = await POST(unsignedRequest(`/api/twilio/${name}`, { CallSid: 'CA1' }));

    expect(response.status).toBe(403);
  });

  it('writes nothing on a rejected request', async () => {
    const { POST } = await import('./status/route');
    await POST(unsignedRequest('/api/twilio/status', { CallStatus: 'completed' }));

    expect(recordCallStatus).not.toHaveBeenCalled();
  });

  it('does not leak which check failed', async () => {
    // An unauthenticated caller learning whether the secret or the signature
    // was wrong is a probing oracle.
    const { POST } = await import('./status/route');
    const response = await POST(unsignedRequest('/api/twilio/status'));

    expect(await response.text()).toBe('unauthorized');
  });
});

describe('the answer webhook', () => {
  it('returns a bidirectional stream for a known call', async () => {
    const { POST } = await import('./voice/route');
    const response = await POST(
      signedRequest('/api/twilio/voice?call=call_1', { CallSid: 'CA1' }),
    );

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('<Connect>');
    expect(body).toContain('call=call_1');
  });

  it('hangs up rather than improvising when the call id is missing', async () => {
    const { POST } = await import('./voice/route');
    const response = await POST(signedRequest('/api/twilio/voice', { CallSid: 'CA1' }));

    expect(await response.text()).toContain('<Hangup');
  });
});

describe('answering-machine detection', () => {
  it('records a machine as voicemail, which nothing else would', async () => {
    const { POST } = await import('./amd/route');
    await POST(
      signedRequest('/api/twilio/amd?call=call_1', {
        CallSid: 'CA1',
        AnsweredBy: 'machine_start',
      }),
    );

    expect(recordCallOutcomeById).toHaveBeenCalledWith(
      expect.objectContaining({ callRecordId: 'call_1', disposition: 'voicemail' }),
    );
  });

  it('never claims the disclosure was heard by a machine', async () => {
    const { POST } = await import('./amd/route');
    await POST(
      signedRequest('/api/twilio/amd?call=call_1', {
        CallSid: 'CA1',
        AnsweredBy: 'machine_end_beep',
      }),
    );

    expect(recordCallOutcomeById.mock.calls[0]?.[0]).toMatchObject({ aiDisclosedAt: null });
  });

  it('does not count "unknown" as voicemail', async () => {
    // AMD said it could not tell. A metric that quietly rounds that to
    // voicemail is worse than one that reports the uncertainty.
    const { POST } = await import('./amd/route');
    await POST(
      signedRequest('/api/twilio/amd?call=call_1', { CallSid: 'CA1', AnsweredBy: 'unknown' }),
    );

    expect(recordCallOutcomeById.mock.calls[0]?.[0]).toMatchObject({
      disposition: 'abandoned_by_agent',
    });
  });

  it('leaves a human call alone entirely', async () => {
    const { POST } = await import('./amd/route');
    const response = await POST(
      signedRequest('/api/twilio/amd?call=call_1', { CallSid: 'CA1', AnsweredBy: 'human' }),
    );

    expect(recordCallOutcomeById).not.toHaveBeenCalled();
    expect(response.status).toBe(204);
  });
});

describe('status callbacks never 5xx', () => {
  it('acknowledges even when the database write throws', async () => {
    recordCallStatus.mockRejectedValue(new Error('connection reset'));

    const { POST } = await import('./status/route');
    const response = await POST(
      signedRequest('/api/twilio/status?call=call_1', {
        CallSid: 'CA1',
        CallStatus: 'completed',
        CallDuration: '94',
      }),
    );

    // Twilio retries any non-2xx and the event has already happened, so a
    // throw here buys a retry storm and nothing else.
    expect(response.status).toBe(204);
  });

  it('records duration and tolerates the absent price Twilio prices later', async () => {
    const { POST } = await import('./status/route');
    await POST(
      signedRequest('/api/twilio/status?call=call_1', {
        CallSid: 'CA1',
        CallStatus: 'completed',
        CallDuration: '94',
      }),
    );

    expect(recordCallStatus).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 94, priceUsd: null }),
    );
  });

  it('ignores non-terminal statuses', async () => {
    const { POST } = await import('./status/route');
    await POST(
      signedRequest('/api/twilio/status?call=call_1', {
        CallSid: 'CA1',
        CallStatus: 'ringing',
      }),
    );

    expect(recordCallStatus).not.toHaveBeenCalled();
  });
});

describe('SMS delivery status surfaces carrier filtering', () => {
  it('flags the silent A2P failure rather than logging a generic error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { POST } = await import('./sms-status/route');
    await POST(
      signedRequest('/api/twilio/sms-status', {
        MessageSid: 'SM1',
        MessageStatus: 'undelivered',
        ErrorCode: '30032',
      }),
    );

    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('CARRIER FILTERING');
    expect(recordMessageStatus).toHaveBeenCalledWith(
      expect.objectContaining({ carrierFiltered: true }),
    );
  });

  it('does not flag an ordinary delivery failure as filtering', async () => {
    const { POST } = await import('./sms-status/route');
    await POST(
      signedRequest('/api/twilio/sms-status', {
        MessageSid: 'SM1',
        MessageStatus: 'undelivered',
        ErrorCode: '30003',
      }),
    );

    expect(recordMessageStatus).toHaveBeenCalledWith(
      expect.objectContaining({ carrierFiltered: false }),
    );
  });
});

describe('inbound STOP', () => {
  it('writes the suppression before confirming it', async () => {
    const { POST } = await import('./sms-inbound/route');
    const response = await POST(
      signedRequest('/api/twilio/sms-inbound', {
        From: '+14155550123',
        Body: 'STOP',
        MessageSid: 'SM1',
      }),
    );

    expect(suppressChannels).toHaveBeenCalledWith(
      expect.objectContaining({ phoneE164: '+14155550123', source: 'sms_stop' }),
    );
    expect(await response.text()).toContain('<Message>');
  });

  it('does not confirm an opt-out it failed to record', async () => {
    suppressChannels.mockRejectedValue(new Error('connection reset'));

    const { POST } = await import('./sms-inbound/route');
    const response = await POST(
      signedRequest('/api/twilio/sms-inbound', { From: '+14155550123', Body: 'STOP' }),
    );

    // Confirming an opt-out we failed to record is worse than a missing
    // confirmation: the person believes they are off the list and is not.
    expect(await response.text()).not.toContain('<Message>');
  });

  it('records a human reply without auto-replying to it', async () => {
    const { POST } = await import('./sms-inbound/route');
    const response = await POST(
      signedRequest('/api/twilio/sms-inbound', {
        From: '+14155550123',
        Body: 'yeah what would that cost',
        MessageSid: 'SM2',
      }),
    );

    expect(recordInboundMessage).toHaveBeenCalled();
    // An unsolicited automated response to a human reply is worse UX and a
    // fresh message under the TCPA.
    expect(await response.text()).not.toContain('<Message>');
  });
});
