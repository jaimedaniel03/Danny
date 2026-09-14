/**
 * Answer webhook — the first thing Twilio asks when the call connects.
 *
 * Returns TwiML opening a bidirectional media stream to the WebSocket server.
 * `<Connect><Stream>` rather than `<Start><Stream>`: the latter only forks audio
 * to you with no way to speak back, which is a frustrating thing to discover
 * after the whole loop is wired.
 *
 * This route answers inbound calls too. An inbound caller has the strongest
 * consent basis there is — they dialled you — so the gate is not consulted here;
 * `evaluateGate` governs who we may call, not who may call us.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { buildStreamTwiml, buildHangupTwiml } from '@/telephony/twilio';
import { verifyTwilioRequest, twimlResponse } from '../_verify';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const verified = await verifyTwilioRequest(request);
  if (!verified.ok) return verified.response;

  const callRecordId = new URL(request.url).searchParams.get('call');
  if (!callRecordId) {
    console.error('[twilio/voice] no call id in webhook URL');
    return twimlResponse(buildHangupTwiml());
  }

  return twimlResponse(buildStreamTwiml({ callRecordId, config: verified.webhook.config }));
}
