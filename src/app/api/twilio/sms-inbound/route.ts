/**
 * Inbound SMS webhook — STOP, HELP, START, and conversation.
 *
 * The STOP path is the single most important handler in the messaging layer.
 * Twilio's Advanced Opt-Out suppresses at the carrier level, but that does not
 * write anything to our database — so without this handler our own records
 * still believe the contact is reachable and the next campaign texts them
 * again. That is the fact pattern that turns one annoyed person into a
 * plaintiff.
 *
 * Suppression is written BEFORE the reply is sent. If the write fails we do not
 * confirm the opt-out, because confirming an opt-out we failed to record is
 * worse than a missing confirmation.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { classifyInboundSms, buildSmsReplyTwiml, buildEmptySmsTwiml } from '@/channels/sms';
import { loadTwilioConfig, validateWebhook } from '@/telephony/twilio';
import { SUPPRESSION_SCOPE } from '@/channels/types';

export const runtime = 'nodejs';

function twiml(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = loadTwilioConfig();

  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value;
  }

  const check = validateWebhook({
    signature: request.headers.get('x-twilio-signature'),
    url: request.url,
    params,
    config,
  });
  if (!check.valid) {
    console.warn('[sms-inbound] rejected webhook:', check.reason);
    return new NextResponse('unauthorized', { status: 403 });
  }

  const from = params['From'] ?? '';
  const body = params['Body'] ?? '';
  const { loadProfileSafe } = await import('@/config/agency');
  const profile = loadProfileSafe();
  const action = classifyInboundSms(
    body,
    profile
      ? { agencyLegalName: profile.legalName, helpPhoneE164: profile.phone.callerIdE164 }
      : undefined,
  );

  switch (action.kind) {
    case 'stop': {
      try {
        const { suppressChannels } = await import('@/db/suppressions');
        // A texted STOP suppresses SMS. It does not, on its own, suppress voice
        // — SUPPRESSION_SCOPE.sms is deliberately narrow, because reading a
        // channel-specific opt-out as a global one loses reachability the
        // person did not ask to give up.
        await suppressChannels({
          phoneE164: from,
          channels: SUPPRESSION_SCOPE.sms,
          reason: `Inbound STOP: "${body.trim().slice(0, 60)}"`,
          source: 'sms_stop',
        });
      } catch (err) {
        // Do not confirm an opt-out we failed to record. Twilio's carrier-level
        // opt-out still applies, so the person stops receiving messages either
        // way; the alert is so a human reconciles our records.
        console.error('[sms-inbound] SUPPRESSION WRITE FAILED — reconcile manually', {
          from,
          err,
        });
        return twiml(buildEmptySmsTwiml());
      }
      return twiml(buildSmsReplyTwiml(action.reply));
    }

    case 'help':
      return twiml(buildSmsReplyTwiml(action.reply));

    case 'start': {
      try {
        const { unsuppressChannel } = await import('@/db/suppressions');
        await unsuppressChannel({ phoneE164: from, channel: 'sms' });
      } catch (err) {
        console.error('[sms-inbound] unsuppress failed', err);
      }
      return twiml(buildSmsReplyTwiml(action.reply));
    }

    case 'conversation': {
      // A human reply is a lead signal and, notably, evidence of engagement.
      // It does NOT create written consent — replying to a text is not a
      // signature — so it routes to a producer rather than unlocking the AI.
      try {
        const { recordInboundMessage } = await import('@/db/messages');
        await recordInboundMessage({
          phoneE164: from,
          channel: 'sms',
          body: action.text,
          providerSid: params['MessageSid'] ?? null,
        });
      } catch (err) {
        console.error('[sms-inbound] failed to record inbound message', err);
      }
      // No auto-reply: an unsolicited automated response to a human reply is
      // both worse UX and a fresh message under the TCPA.
      return twiml(buildEmptySmsTwiml());
    }
  }
}
