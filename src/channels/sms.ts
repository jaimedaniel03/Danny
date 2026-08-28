/**
 * SMS channel.
 *
 * ── Two separate rulebooks, and you must satisfy both ────────────────────────
 *
 * **The law.** A text is a "call" under the TCPA. A promotional text to a
 * wireless number needs prior express written consent — the same bar as an AI
 * voice call. This surprises people constantly, because texting *feels* casual.
 * Florida's FTSA and its imitators add state-level exposure on top.
 *
 * **The carriers.** Independent of the law, US carriers enforce A2P 10DLC:
 * every business sender must register a Brand and a Campaign, disclose sample
 * message content, and honour STOP/HELP. Unregistered traffic is filtered
 * silently — your messages simply do not arrive, with a delivery receipt that
 * says they did. That failure mode costs more startups than the TCPA does,
 * because it is invisible.
 *
 * Both are enforced here: the gate handles consent, `assertRegistered` handles
 * 10DLC, and STOP/HELP are answered in `handleInboundSms` below.
 */

import twilio from 'twilio';
import type { ChannelAuthorization } from './types';
import type { TwilioConfig } from '@/telephony/twilio';

/** Carrier-mandated keywords. Handled by Twilio Advanced Opt-Out AND by us. */
export const STOP_KEYWORDS: readonly string[] = [
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'revoke',
];
export const HELP_KEYWORDS: readonly string[] = ['help', 'info'];
export const START_KEYWORDS: readonly string[] = ['start', 'unstop', 'yes'];

/**
 * SMS segments at 160 GSM-7 characters, or 70 if any character forces UCS-2.
 * A single curly apostrophe or an em dash flips the whole message to UCS-2 and
 * more than doubles your per-message cost — so we detect it rather than
 * discovering it on the bill.
 */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

export interface SegmentInfo {
  readonly encoding: 'GSM-7' | 'UCS-2';
  readonly characters: number;
  readonly segments: number;
  readonly offendingCharacters: readonly string[];
}

export function analyzeSegments(text: string): SegmentInfo {
  const offending = new Set<string>();
  let units = 0;

  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXTENDED.includes(ch)) units += 2; // escape + char
    else {
      offending.add(ch);
      units += 1;
    }
  }

  const encoding = offending.size > 0 ? 'UCS-2' : 'GSM-7';
  const single = encoding === 'GSM-7' ? 160 : 70;
  const concatenated = encoding === 'GSM-7' ? 153 : 67;
  const segments = units <= single ? 1 : Math.ceil(units / concatenated);

  return {
    encoding,
    characters: units,
    segments,
    offendingCharacters: [...offending],
  };
}

/**
 * Replace typographic characters with GSM-7 equivalents.
 *
 * Worth doing automatically: an em dash or a curly quote is invisible to whoever
 * wrote the copy and silently doubles the cost of every message in the campaign.
 */
export function normalizeForGsm7(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[•·]/g, '-');
}

export class NotRegisteredError extends Error {
  constructor() {
    super(
      'A2P 10DLC registration is not configured. Set TWILIO_MESSAGING_SERVICE_SID ' +
        'to a Messaging Service attached to a registered Brand and Campaign. ' +
        'Unregistered A2P traffic is silently filtered by US carriers — messages ' +
        'appear sent and never arrive, which is far harder to debug than an error.',
    );
    this.name = 'NotRegisteredError';
  }
}

export interface SmsConfig {
  readonly twilio: TwilioConfig;
  /** Messaging Service SID — carries the 10DLC registration and the number pool. */
  readonly messagingServiceSid: string | null;
}

export function loadSmsConfig(twilioConfig: TwilioConfig): SmsConfig {
  return {
    twilio: twilioConfig,
    messagingServiceSid: process.env['TWILIO_MESSAGING_SERVICE_SID'] ?? null,
  };
}

export interface SentSms {
  readonly providerSid: string;
  readonly segments: number;
  readonly encoding: 'GSM-7' | 'UCS-2';
  readonly body: string;
  readonly dryRun: boolean;
}

/**
 * Send one SMS.
 *
 * Takes a `ChannelAuthorization`, which only the channel gate can produce, so
 * an unchecked send does not typecheck.
 */
export async function sendSms(input: {
  readonly authorization: ChannelAuthorization;
  readonly config: SmsConfig;
  readonly body: string;
  readonly now?: Date;
}): Promise<SentSms> {
  const { authorization, config } = input;
  const now = input.now ?? new Date();

  if (authorization.channel !== 'sms') {
    throw new Error(`Authorization is for "${authorization.channel}", not sms.`);
  }
  if (now >= authorization.expiresAt) {
    throw new Error('Channel authorization expired. Re-evaluate the gate rather than retrying.');
  }
  if (!config.messagingServiceSid && !config.twilio.dryRun) {
    throw new NotRegisteredError();
  }

  // The opt-out footer is appended here, by the runtime — not left to whoever
  // wrote the message template, and not to a model.
  const normalized = normalizeForGsm7(input.body.trim());
  const footer = authorization.requiredFooter;
  const body = footer && !normalized.includes('STOP') ? `${normalized}\n\n${footer}` : normalized;

  const info = analyzeSegments(body);

  if (config.twilio.dryRun) {
    return {
      providerSid: `DRYRUN_SMS_${Date.now()}`,
      segments: info.segments,
      encoding: info.encoding,
      body,
      dryRun: true,
    };
  }

  // Unreachable unless dryRun was false and the SID was present — the guard
  // above throws otherwise — but narrow explicitly rather than asserting.
  if (!config.messagingServiceSid) throw new NotRegisteredError();

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const base = config.twilio.publicBaseUrl.replace(/\/+$/, '');

  const message = await client.messages.create({
    to: authorization.destination,
    // Send via the Messaging Service, not a bare number: that is what carries
    // the 10DLC registration and the sticky-sender number pool.
    messagingServiceSid: config.messagingServiceSid,
    body,
    statusCallback: `${base}/api/twilio/sms-status?s=${config.twilio.webhookSecret}`,
  });

  return {
    providerSid: message.sid,
    segments: info.segments,
    encoding: info.encoding,
    body,
    dryRun: false,
  };
}

// ─────────────────────────────────────────────────────────────
// Inbound
// ─────────────────────────────────────────────────────────────

export type InboundSmsAction =
  | { readonly kind: 'stop'; readonly reply: string }
  | { readonly kind: 'help'; readonly reply: string }
  | { readonly kind: 'start'; readonly reply: string }
  | { readonly kind: 'conversation'; readonly text: string };

/**
 * Classify an inbound text.
 *
 * Twilio's Advanced Opt-Out handles STOP at the carrier level, but we classify
 * independently and suppress in our own database too. Relying solely on the
 * carrier means your database still believes the contact is reachable, and the
 * next campaign — or the next vendor — happily texts them again.
 *
 * Matching is on the first word only. "Stop by the office tomorrow" is a
 * conversation, not an opt-out, and treating it as one loses a customer.
 */
export function classifyInboundSms(body: string): InboundSmsAction {
  const firstWord = body.trim().toLowerCase().replace(/[^a-z-]/g, '');

  if (STOP_KEYWORDS.includes(firstWord)) {
    return {
      kind: 'stop',
      reply:
        'You are unsubscribed and will receive no further messages. ' +
        'Reply START to resubscribe.',
    };
  }
  if (HELP_KEYWORDS.includes(firstWord)) {
    return {
      kind: 'help',
      reply:
        `${process.env['AGENCY_LEGAL_NAME'] ?? 'Our agency'}: insurance quotes and ` +
        `service. Call ${process.env['TWILIO_CALLER_ID'] ?? 'us'} for help. ` +
        `Reply STOP to opt out. Msg&data rates may apply.`,
    };
  }
  if (START_KEYWORDS.includes(firstWord)) {
    return {
      kind: 'start',
      reply: 'You are resubscribed. Reply STOP to opt out at any time.',
    };
  }

  return { kind: 'conversation', text: body.trim() };
}

/** TwiML for a bare reply. */
export function buildSmsReplyTwiml(message: string): string {
  const response = new twilio.twiml.MessagingResponse();
  response.message(message);
  return response.toString();
}

export function buildEmptySmsTwiml(): string {
  return new twilio.twiml.MessagingResponse().toString();
}
