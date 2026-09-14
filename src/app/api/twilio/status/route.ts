/**
 * Call status callbacks: initiated, ringing, answered, completed.
 *
 * The `completed` event is the authoritative end of a call. The media server's
 * own `finish()` usually fires first, but not always — a call that never
 * connects produces no media stream at all, so without this route those
 * attempts would leave a registry entry and no record.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { releasePendingCall } from '@/telephony/call-registry';
import { verifyTwilioRequest, acknowledged } from '../_verify';

export const runtime = 'nodejs';

const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const verified = await verifyTwilioRequest(request);
  if (!verified.ok) return verified.response;

  const { params } = verified.webhook;
  const callRecordId = new URL(request.url).searchParams.get('call');
  const status = params['CallStatus'] ?? 'unknown';

  if (TERMINAL.has(status)) {
    if (callRecordId) releasePendingCall(callRecordId);

    try {
      const { recordCallStatus } = await import('@/db/calls');
      await recordCallStatus({
        callRecordId,
        providerSid: params['CallSid'] ?? null,
        status,
        durationSeconds: params['CallDuration'] ? Number.parseInt(params['CallDuration'], 10) : null,
        // Twilio prices asynchronously, so this is often absent on the
        // completion event and backfilled later. Null is normal, not an error.
        priceUsd: params['Price'] ? Number.parseFloat(params['Price']) : null,
      });
    } catch (err) {
      // Never 5xx a status callback: the event already happened and a Twilio
      // retry cannot change it, so a retry storm is the only outcome.
      console.error('[twilio/status] failed to record', err);
    }
  }

  return acknowledged();
}
