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
import type { CallDisposition } from '@/types';

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

    // Record the disposition here, because nothing else will.
    //
    // A machine-answered call never opens a media stream, so the session's
    // `onComplete` never runs; and Twilio reports the leg as `completed`, which
    // the status callback deliberately leaves alone so it cannot overwrite a
    // real conversation's outcome. Between the two, every voicemail hit was
    // landing as a completed call with no disposition at all — which makes
    // "what share of our dials reach a machine" unanswerable, and that is one
    // of the two numbers that decide whether a dialing strategy works.
    if (callRecordId) {
      try {
        const { recordCallOutcomeById } = await import('@/db/calls');
        await recordCallOutcomeById({
          callRecordId,
          disposition: dispositionForAmd(result),
          finalState: `amd:${result}`,
          durationSeconds: 0,
          // Nobody heard it. Claiming otherwise would put a false timestamp in
          // the one field that evidences the disclosure was spoken.
          aiDisclosedAt: null,
        });
      } catch (err) {
        console.error('[twilio/amd] failed to record disposition', err);
      }
    }
  }

  return acknowledged();
}

/**
 * AMD outcome → disposition.
 *
 * `unknown` is not recorded as voicemail. AMD said it could not tell, and a
 * metric that quietly counts "we don't know" as "voicemail" is worse than one
 * that reports the uncertainty.
 */
function dispositionForAmd(result: AmdResult): CallDisposition {
  if (result === 'fax') return 'failed';
  if (result === 'unknown') return 'abandoned_by_agent';
  return 'voicemail';
}
