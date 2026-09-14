/**
 * Answering-machine detection result.
 *
 * Only `human` continues. Everything else hangs up, and the reason is not
 * squeamishness about voicemail: a prerecorded artificial-voice message left on
 * a wireless number sits squarely inside TCPA 227(b), and the consent analysis
 * for a voicemail drop is a different question from the one for a live
 * conversation. We have answered the second and not the first.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { shouldContinueAfterAmd, type AmdResult } from '@/telephony/twilio';
import { releasePendingCall } from '@/telephony/call-registry';
import { verifyTwilioRequest, acknowledged } from '../_verify';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const verified = await verifyTwilioRequest(request);
  if (!verified.ok) return verified.response;

  const callRecordId = new URL(request.url).searchParams.get('call');
  const result = (verified.webhook.params['AnsweredBy'] ?? 'unknown') as AmdResult;

  if (!shouldContinueAfterAmd(result)) {
    console.info(`[twilio/amd] ${callRecordId}: ${result} — hanging up, no AI voicemail`);
    if (callRecordId) releasePendingCall(callRecordId);

    try {
      const { hangUpCall } = await import('@/telephony/twilio');
      const sid = verified.webhook.params['CallSid'];
      if (sid) await hangUpCall({ providerSid: sid, config: verified.webhook.config });
    } catch (err) {
      console.error('[twilio/amd] hangup failed', err);
    }
  }

  return acknowledged();
}
