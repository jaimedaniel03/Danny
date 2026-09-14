/**
 * SMS delivery status.
 *
 * Worth handling rather than ignoring, for one specific reason: error 30032
 * and its neighbours mean **carrier filtering**, which is what unregistered or
 * poorly-rated A2P traffic looks like from the outside. Messages report as sent
 * and never arrive. Without this route that failure is completely invisible —
 * you conclude nobody replies to your texts.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { verifyTwilioRequest, acknowledged } from '../_verify';

export const runtime = 'nodejs';

/** Twilio error codes that mean a carrier dropped the message. */
const FILTERING_CODES = new Set(['30007', '30032', '30034', '30037', '30045']);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const verified = await verifyTwilioRequest(request);
  if (!verified.ok) return verified.response;

  const { params } = verified.webhook;
  const status = params['MessageStatus'] ?? 'unknown';
  const errorCode = params['ErrorCode'] ?? null;

  if (errorCode && FILTERING_CODES.has(errorCode)) {
    console.error(
      `[twilio/sms-status] CARRIER FILTERING (error ${errorCode}) on ${params['MessageSid']}. ` +
        'This is the silent A2P 10DLC failure: messages report as sent and never arrive. ' +
        'Check that TWILIO_MESSAGING_SERVICE_SID points at a registered Brand and Campaign.',
    );
  }

  try {
    const { recordMessageStatus } = await import('@/db/messages');
    await recordMessageStatus({
      providerId: params['MessageSid'] ?? null,
      status,
      errorCode,
      carrierFiltered: errorCode !== null && FILTERING_CODES.has(errorCode),
    });
  } catch (err) {
    console.error('[twilio/sms-status] failed to record', err);
  }

  return acknowledged();
}
