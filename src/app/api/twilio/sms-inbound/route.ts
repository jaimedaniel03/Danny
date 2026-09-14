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

import { type NextRequest, NextResponse } from 'next/server';
import { classifyInboundSms, buildSmsReplyTwiml, buildEmptySmsTwiml } from '@/channels/sms';
import { SUPPRESSION_SCOPE } from '@/channels/types';
import { verifyTwilioRequest, twimlResponse } from '../_verify';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Uses the shared verifier rather than its own copy of the same three steps.
  // It had one, which is exactly the drift `_verify.ts` exists to prevent: the
  // inline version also called `loadTwilioConfig()` unguarded, so a
  // misconfiguration surfaced as an unhandled 500 with a stack trace instead of
  // the handled one every other route returns.
  const verified = await verifyTwilioRequest(request);
  if (!verified.ok) return verified.response;

  const { params } = verified.webhook;
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
        return twimlResponse(buildEmptySmsTwiml());
      }
      return twimlResponse(buildSmsReplyTwiml(action.reply));
    }

    case 'help':
      return twimlResponse(buildSmsReplyTwiml(action.reply));

    case 'start': {
      try {
        const { unsuppressChannel } = await import('@/db/suppressions');
        await unsuppressChannel({ phoneE164: from, channel: 'sms' });
      } catch (err) {
        console.error('[sms-inbound] unsuppress failed', err);
      }
      return twimlResponse(buildSmsReplyTwiml(action.reply));
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
      return twimlResponse(buildEmptySmsTwiml());
    }
  }
}
